/**
 * Launches a declaratively-delegated workflow step as a pi subagent in a
 * terminal-multiplexer surface, waits for it to finish, and extracts the final
 * assistant message as the step summary.
 */
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnvilAbortError, ReviewSubagentUnavailableError, throwIfAborted } from "../errors.ts";
import * as cmux from "./cmux.ts";
import * as herdr from "./herdr.ts";
import { shellEscape, SUBAGENT_SENTINEL_PREFIX, type SubagentExit } from "./cmux.ts";
import {
	containsUnsafeControlCharacters,
	independentReviewReason,
	INDEPENDENT_REVIEW_MODE,
	INDEPENDENT_REVIEW_TOOL_NAMES,
	MAX_REVIEW_REASON_BYTES,
	MAX_REVIEW_VERDICT_BYTES,
	SUBAGENT_READY_MARKER,
} from "./child.ts";
import { DEFAULT_SUBAGENT_TIMEOUT_MS, SUBAGENT_PROVIDER_ERROR_MESSAGE } from "./exit.ts";
import { isSensitiveReviewPath } from "./review-fs.ts";

// Load Anvil's normal entrypoint so source/dev sessions always have the same
// PI_ANVIL_SUBAGENT_SESSION child-mode behavior as discovered installations.
const anvilExtensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const reviewChildExtensionPath = fileURLToPath(new URL("./child.ts", import.meta.url));
const trustedNodeExecutablePath = realpathSync.native(process.execPath);
const trustedPiCliPath = realpathSync.native(fileURLToPath(
	new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
));
const REVIEW_TOOLS = INDEPENDENT_REVIEW_TOOL_NAMES.join(",");
export const SUBAGENT_READY_TIMEOUT_MS = 5_000;
export const SUBAGENT_BOOTSTRAP_ATTEMPTS = 3;
export const SUBAGENT_TRANSPORT_FAILURE_LIMIT = 3;
export const SUBAGENT_TRANSPORT_FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_SUBAGENT_SESSION_SCAN_BYTES = 256 * 1024;
const SUBAGENT_BOOTSTRAP_RETRY_DELAY_MS = 250;
const SUBAGENT_TRANSPORT_RETRY_DELAY_MS = 1_000;
export const SUBAGENT_CLEANUP_TIMEOUT_MS = 5_000;
const REVIEW_RUNTIME_ENVIRONMENT = [
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"TERM",
	"COLORTERM",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"PI_PACKAGE_DIR",
	"PI_OFFLINE",
	"PI_SKIP_VERSION_CHECK",
	"PI_TELEMETRY",
] as const;

const REVIEW_PROVIDER_ENVIRONMENT: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "PI_CACHE_RETENTION"],
	"ant-ling": ["ANT_LING_API_KEY"],
	openai: ["OPENAI_API_KEY", "PI_CACHE_RETENTION"],
	"openai-codex": ["OPENAI_API_KEY", "PI_CACHE_RETENTION"],
	"azure-openai-responses": [
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_BASE_URL",
		"AZURE_OPENAI_RESOURCE_NAME",
		"AZURE_OPENAI_API_VERSION",
		"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	],
	deepseek: ["DEEPSEEK_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
	google: ["GEMINI_API_KEY"],
	"google-vertex": [
		"GOOGLE_CLOUD_API_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
	],
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	xai: ["XAI_API_KEY"],
	fireworks: ["FIREWORKS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	zai: ["ZAI_API_KEY"],
	"zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY"],
	huggingface: ["HF_TOKEN"],
	"github-copilot": ["COPILOT_GITHUB_TOKEN"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
	xiaomi: ["XIAOMI_API_KEY"],
	"xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	"xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
	"amazon-bedrock": [
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_ROLE_ARN",
		"AWS_ROLE_SESSION_NAME",
		"AWS_SHARED_CREDENTIALS_FILE",
		"AWS_CONFIG_FILE",
		"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
		"AWS_BEDROCK_SKIP_AUTH",
		"AWS_BEDROCK_FORCE_HTTP1",
		"AWS_BEDROCK_FORCE_CACHE",
	],
};

interface ReviewIdentity {
	agentDir: string;
	homeDir: string;
}

interface JsonRecord {
	[key: string]: unknown;
}

export interface SubagentLaunch {
	/** Display name for the subagent terminal surface. */
	name: string;
	/** Full task prompt for the subagent. */
	task: string;
	/** Working directory the subagent starts in. */
	cwd: string;
	runId: string;
	stepId: string;
	/** Pi model reference (provider/id) for the child session. */
	model?: string;
	thinkingLevel?: string;
	timeoutMs?: number;
}

export interface SubagentResult {
	summary: string;
	sessionFile: string;
	exitCode: number;
	errorMessage?: string;
}

export interface ReviewSubagentLaunch extends SubagentLaunch {
	/** Runtime check id that the review child must echo in its verdict. */
	checkId: string;
}

export interface ReviewSubagentResult extends IndependentReviewVerdict {
	sessionFile: string;
	exitCode: number;
}

export interface SubagentBootstrapOptions {
	readyTimeoutMs?: number;
	attempts?: number;
	retryDelayMs?: number;
	/** Internal/test overrides for retrying provider transport failures. */
	transportFailureLimit?: number;
	transportFailureWindowMs?: number;
	transportRetryDelayMs?: number;
	cleanupTimeoutMs?: number;
	now?: () => number;
}

export interface IndependentReviewVerdict {
	checkId: string;
	pass: boolean;
	reason: string;
}

/**
 * Reads the one structured verdict emitted by an isolated review child.
 * Transport failures deliberately throw rather than being converted to failed
 * reviews, so later gate wiring can distinguish infrastructure errors.
 */
export async function readIndependentReviewVerdict(
	sessionFile: string,
	expectedCheckId: string,
): Promise<IndependentReviewVerdict> {
	const sidecarFile = `${sessionFile}.verdict.json`;
	let handle;
	try {
		handle = await open(sidecarFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (isMissingFileError(error)) {
			throw new Error(`Missing independent review verdict sidecar: ${sidecarFile}`);
		}
		if (isSymlinkError(error)) {
			throw new Error(`Invalid independent review verdict sidecar: symbolic links are not allowed.`);
		}
		throw error;
	}

	let text: string;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new Error("Invalid independent review verdict sidecar: expected a regular file.");
		}
		const buffer = Buffer.alloc(MAX_REVIEW_VERDICT_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_REVIEW_VERDICT_BYTES) {
			throw new Error(`Independent review verdict sidecar exceeds ${MAX_REVIEW_VERDICT_BYTES} bytes: ${sidecarFile}`);
		}
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
		} catch {
			throw new Error(`Malformed independent review verdict sidecar: invalid UTF-8: ${sidecarFile}`);
		}
	} finally {
		await handle.close();
	}

	const records = text.split("\n").filter((line) => line.trim());
	if (records.length !== 1) {
		throw new Error(
			records.length === 0
				? `Malformed independent review verdict sidecar: ${sidecarFile}`
				: `Duplicate independent review verdict records in sidecar: ${sidecarFile}`,
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(records[0]);
	} catch {
		throw new Error(`Malformed independent review verdict sidecar: ${sidecarFile}`);
	}
	if (isDuplicateReviewVerdictPayload(payload)) {
		throw new Error(`Duplicate independent review verdict records in sidecar: ${sidecarFile}`);
	}
	if (!isIndependentReviewVerdictPayload(payload)) {
		throw new Error(`Invalid independent review verdict sidecar: ${sidecarFile}`);
	}
	if (Buffer.byteLength(payload.reason, "utf8") > MAX_REVIEW_REASON_BYTES) {
		throw new Error(`Invalid independent review verdict sidecar: reason exceeds ${MAX_REVIEW_REASON_BYTES} bytes.`);
	}
	if (containsUnsafeControlCharacters(payload.reason)) {
		throw new Error("Invalid independent review verdict sidecar: reason contains unsupported control characters.");
	}
	if (payload.check_id !== expectedCheckId) {
		throw new Error("Independent review verdict check_id does not match the expected check_id.");
	}
	// Treat the reason as reviewer-controlled secret-bearing input. Even a
	// hand-written or compromised sidecar must not feed arbitrary prose into
	// checkpoints, UI, retry feedback, or resume prompts.
	return { checkId: payload.check_id, pass: payload.pass, reason: independentReviewReason(payload.pass) };
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isSymlinkError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ELOOP";
}

function isDuplicateReviewVerdictPayload(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).transport_error === "duplicate"
	);
}

function isIndependentReviewVerdictPayload(
	value: unknown,
): value is { check_id: string; pass: boolean; reason: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	const keys = Object.keys(payload);
	return (
		keys.length === 3 &&
		keys.includes("check_id") &&
		keys.includes("pass") &&
		keys.includes("reason") &&
		typeof payload.check_id === "string" &&
		payload.check_id.trim().length > 0 &&
		typeof payload.pass === "boolean" &&
		typeof payload.reason === "string" &&
		payload.reason.trim().length > 0
	);
}

interface SubagentCommandArgs {
	cwd: string;
	sessionFile: string;
	taskFile?: string;
	model?: string;
	thinkingLevel?: string;
	sentinelNonce?: string;
	/** Isolated Pi configuration containing only the selected review provider. */
	reviewAgentDir?: string;
	/** Isolated home used to prevent implicit access to unrelated cloud credentials. */
	reviewHomeDir?: string;
}

export function buildSubagentBootstrapCommand(args: SubagentCommandArgs): string {
	return buildBootstrapCommand(args, "step");
}

/**
 * Builds a review-only child command. Review sessions explicitly reject
 * project trust, disable every discovered resource, expose only Anvil's
 * cwd-confined read-only artifact tools plus the verdict tool, and start Pi
 * with a minimal allowlisted environment. Normal workflow step extension
 * discovery and tool access remain unchanged.
 */
export function buildReviewSubagentBootstrapCommand(args: SubagentCommandArgs): string {
	return buildBootstrapCommand(args, "review");
}

function buildBootstrapCommand(args: SubagentCommandArgs, mode: "step" | "review"): string {
	const isReview = mode === "review";
	const extensionPath = isReview ? reviewChildExtensionPath : anvilExtensionPath;
	const parts = isReview
		? [shellEscape(trustedNodeExecutablePath), shellEscape(trustedPiCliPath), "--no-approve"]
		: ["pi", "--approve"];
	if (isReview) {
		parts.push(
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--tools",
			REVIEW_TOOLS,
		);
	}
	parts.push("-e", shellEscape(extensionPath), "--session", shellEscape(args.sessionFile));
	if (args.model) parts.push("--model", shellEscape(args.model));
	if (args.thinkingLevel) parts.push("--thinking", shellEscape(args.thinkingLevel));
	// CLI file arguments are submitted as Pi's initial prompt. This avoids
	// racing the interactive @-mention picker with synthetic Enter keystrokes.
	if (args.taskFile) parts.push(shellEscape(`@${args.taskFile}`));

	const sentinelNonce = args.sentinelNonce ?? newSentinelNonce();
	const legacySentinelNote = `# legacy sentinel format: status=$?; echo '${SUBAGENT_SENTINEL_PREFIX}'"\${status}"'__'`;
	const sessionEnvironment = isReview
		? ""
		: `PI_ANVIL_SUBAGENT_SESSION=${shellEscape(args.sessionFile)} PI_ANVIL_SUBAGENT_MODE='step' `;
	const innerCommand = `cd ${shellEscape(args.cwd)} && ${sessionEnvironment}${parts.join(" ")}; status=$?; echo '${SUBAGENT_SENTINEL_PREFIX}${sentinelNonce}_'"\${status}"'__'; exit "\${status}"; ${legacySentinelNote}`;
	if (!isReview) return `bash -lc ${shellDoubleEscape(innerCommand)}`;

	// Scrub the environment before starting Bash, and suppress every Bash
	// startup file. Otherwise BASH_ENV or login hooks can observe inherited
	// credentials before an inner `env -i` gets a chance to remove them.
	return `${buildReviewEnvironment(args)} /bin/bash --noprofile --norc -c ${shellDoubleEscape(innerCommand)}`;
}

function buildReviewEnvironment(args: SubagentCommandArgs): string {
	const inherited = REVIEW_RUNTIME_ENVIRONMENT.map((name) => `${name}="\${${name}-}"`);
	const identityRoot = dirname(args.sessionFile);
	return [
		"/usr/bin/env",
		"-i",
		"PATH='/usr/bin:/bin'",
		...inherited,
		`HOME=${shellEscape(args.reviewHomeDir ?? join(identityRoot, "review-home"))}`,
		`PI_CODING_AGENT_DIR=${shellEscape(args.reviewAgentDir ?? join(identityRoot, "review-agent"))}`,
		`PI_ANVIL_SUBAGENT_SESSION=${shellEscape(args.sessionFile)}`,
		`PI_ANVIL_SUBAGENT_MODE=${shellEscape(INDEPENDENT_REVIEW_MODE)}`,
		`PI_ANVIL_REVIEW_ROOT=${shellEscape(args.cwd)}`,
	].join(" ");
}

function prepareReviewIdentity(workDir: string, model: string | undefined): ReviewIdentity {
	const provider = selectedModelProvider(model);
	const identityRoot = mkdtempSync(join(workDir, "review-identity-"));
	try {
		chmodSync(identityRoot, 0o700);
		const agentDir = join(identityRoot, "agent");
		const homeDir = join(identityRoot, "home");
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		mkdirSync(homeDir, { recursive: true, mode: 0o700 });

		const sourceAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const sourceAuth = readJsonRecord(join(sourceAgentDir, "auth.json"));
		const sourceModels = readJsonRecord(join(sourceAgentDir, "models.json"));
		const providerConfig = recordValue(sourceModels?.providers)?.[provider];
		const credential = cloneJsonValue(sourceAuth?.[provider]);
		// Never promote arbitrary `$ENV` references from user-controlled provider/model
		// configuration into the review identity. Only Anvil's provider-specific allowlist
		// may cross the fresh-review environment boundary.
		const requiredEnvironment = new Set(REVIEW_PROVIDER_ENVIRONMENT[provider] ?? []);
		const credentialEnvironment = Object.fromEntries(
			[...requiredEnvironment]
				.map((name) => [name, process.env[name]] as const)
				.filter((entry): entry is [string, string] => entry[1] !== undefined),
		);

		let selectedCredential = recordValue(credential);
		if (!selectedCredential && Object.keys(credentialEnvironment).length > 0) {
			const providerApiKey = recordValue(providerConfig)?.apiKey;
			const keyEnvironment = [...requiredEnvironment].find((name) => isProviderKeyEnvironment(name) && process.env[name]);
			selectedCredential = {
				type: "api_key",
				key: typeof providerApiKey === "string"
					? providerApiKey
					: keyEnvironment
						? `$${keyEnvironment}`
						: "<authenticated>",
			};
		}
		if (selectedCredential) {
			if (selectedCredential.type === "api_key") {
				const configuredEnvironment = recordValue(selectedCredential.env) ?? {};
				const requiredConfiguredEnvironment = Object.fromEntries(
					Object.entries(configuredEnvironment).filter(([name]) => requiredEnvironment.has(name)),
				);
				selectedCredential.env = { ...credentialEnvironment, ...requiredConfiguredEnvironment };
			}
			writePrivateJson(join(agentDir, "auth.json"), { [provider]: selectedCredential });
		}

		const filteredModels = filterModelsForProvider(sourceModels, provider);
		if (filteredModels) writePrivateJson(join(agentDir, "models.json"), filteredModels);
		copySelectedCloudFiles(provider, homeDir);
		return { agentDir, homeDir };
	} catch (error) {
		rmSync(identityRoot, { recursive: true, force: true });
		throw error;
	}
}

function selectedModelProvider(model: string | undefined): string {
	const separator = model?.indexOf("/") ?? -1;
	const provider = separator > 0 ? model!.slice(0, separator).trim() : "";
	const modelId = separator > 0 ? model!.slice(separator + 1).trim() : "";
	if (!provider || !modelId) {
		throw new Error("Independent review requires an explicit provider/model selection.");
	}
	return provider;
}

function filterModelsForProvider(models: JsonRecord | undefined, provider: string): JsonRecord | undefined {
	if (!models) return undefined;
	const providers = recordValue(models.providers);
	const providerConfig = providers?.[provider];
	const modelOverrides = recordValue(models.modelOverrides);
	const selectedOverrides = modelOverrides
		? Object.fromEntries(Object.entries(modelOverrides).filter(([key]) => key.startsWith(`${provider}/`)))
		: {};
	if (providerConfig === undefined && Object.keys(selectedOverrides).length === 0) return undefined;
	return {
		...(providerConfig === undefined ? {} : { providers: { [provider]: providerConfig } }),
		...(Object.keys(selectedOverrides).length === 0 ? {} : { modelOverrides: selectedOverrides }),
	};
}

function copySelectedCloudFiles(provider: string, isolatedHome: string): void {
	const sourceHome = homedir();
	if (provider === "google-vertex" && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
		copyPrivateFile(
			join(sourceHome, ".config", "gcloud", "application_default_credentials.json"),
			join(isolatedHome, ".config", "gcloud", "application_default_credentials.json"),
		);
	}
	if (provider !== "amazon-bedrock") return;
	if (!process.env.AWS_SHARED_CREDENTIALS_FILE) {
		copyPrivateFile(join(sourceHome, ".aws", "credentials"), join(isolatedHome, ".aws", "credentials"));
	}
	if (!process.env.AWS_CONFIG_FILE) {
		copyPrivateFile(join(sourceHome, ".aws", "config"), join(isolatedHome, ".aws", "config"));
	}
}

function copyPrivateFile(source: string, destination: string): void {
	if (!existsSync(source)) return;
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	copyFileSync(source, destination);
	chmodSync(destination, 0o600);
}

function writePrivateJson(path: string, value: JsonRecord): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readJsonRecord(path: string): JsonRecord | undefined {
	try {
		return recordValue(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

function cloneJsonValue(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function recordValue(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function isProviderKeyEnvironment(name: string): boolean {
	return /(?:API_KEY|OAUTH_TOKEN|TOKEN_BEDROCK|HF_TOKEN|GITHUB_TOKEN)$/u.test(name);
}

function removeReviewIdentity(identity: ReviewIdentity | undefined): void {
	if (!identity) return;
	rmSync(dirname(identity.agentDir), { recursive: true, force: true });
}

function newSentinelNonce(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function shellDoubleEscape(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export class SubagentReadyTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Subagent child did not signal readiness within ${timeoutMs}ms.`);
		this.name = "SubagentReadyTimeoutError";
	}
}

export async function waitForSubagentReady(sessionFile: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const readyFile = `${sessionFile}.ready`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		throwIfAborted(signal);
		let handle;
		try {
			handle = await open(readyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size !== Buffer.byteLength(SUBAGENT_READY_MARKER, "utf8")) {
				throw new Error("Invalid subagent readiness sidecar.");
			}
			const buffer = Buffer.alloc(stat.size);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (buffer.toString("utf8", 0, bytesRead) !== SUBAGENT_READY_MARKER) {
				throw new Error("Invalid subagent readiness sidecar.");
			}
			return;
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		} finally {
			await handle?.close();
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new SubagentReadyTimeoutError(timeoutMs);
		await sleep(Math.min(50, remainingMs), signal);
	}
}

export async function extractLastAssistantText(sessionFile: string): Promise<string | undefined> {
	let handle;
	try {
		handle = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		if (isSymlinkError(error)) throw new Error("Invalid subagent session file: symbolic links are not allowed.");
		throw error;
	}

	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return undefined;
		const bytesToRead = Math.min(stat.size, MAX_SUBAGENT_SESSION_SCAN_BYTES);
		const start = stat.size - bytesToRead;
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		let sessionTail = buffer.subarray(0, bytesRead);
		if (start > 0) {
			const firstLineEnd = sessionTail.indexOf(0x0a);
			if (firstLineEnd < 0) return undefined;
			sessionTail = sessionTail.subarray(firstLineEnd + 1);
		}

		let last: string | undefined;
		for (const line of sessionTail.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: { type?: string; message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const content = entry.message.content;
			const text = Array.isArray(content)
				? content
						.filter((block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string")
						.map((block) => block.text)
						.join("\n")
						.trim()
				: "";
			if (text) last = text;
		}
		return last;
	} finally {
		await handle.close();
	}
}

export async function summarizeSubagentExit(
	sessionFile: string,
	exit: SubagentExit,
): Promise<Pick<SubagentResult, "summary" | "errorMessage">> {
	if (exit.exitCode !== 0) {
		const errorMessage = `Subagent exited with code ${exit.exitCode}; failure details omitted.`;
		return { summary: errorMessage, errorMessage };
	}
	return { summary: (await extractLastAssistantText(sessionFile)) ?? "Subagent exited without output." };
}

interface SubagentBackendAdapter {
	isAvailable(): boolean;
	unavailableMessage(): string;
	createSurface(name: string, signal?: AbortSignal, onCreated?: (surface: string) => void): Promise<string>;
	sendLongCommand(surface: string, command: string, scriptPath: string, signal?: AbortSignal): Promise<void>;
	pollForExit(
		surface: string,
		sessionFile: string,
		signal?: AbortSignal,
		intervalMs?: number,
		timeoutMs?: number,
		sentinelNonce?: string,
	): Promise<SubagentExit>;
	closeSurface(surface: string, signal?: AbortSignal): Promise<void>;
}

/* v8 ignore start -- launches real multiplexer/pi child processes; command building and summary extraction are covered separately. */
export async function runCmuxSubagent(launch: SubagentLaunch, signal?: AbortSignal): Promise<SubagentResult> {
	return runSubagentWithBackend(launch, cmuxBackend(cmux.createSurface), signal);
}

export function createCmuxSubagentRunner(): (launch: SubagentLaunch, signal?: AbortSignal) => Promise<SubagentResult> {
	const surfaces = cmux.createSurfaceManager();
	return (launch, signal) => runSubagentWithBackend(launch, cmuxBackend(surfaces.createSurface), signal);
}

export async function runCmuxReviewSubagent(
	launch: ReviewSubagentLaunch,
	signal?: AbortSignal,
): Promise<ReviewSubagentResult> {
	return runReviewSubagentWithBackend(launch, cmuxBackend(cmux.createSurface), signal);
}

export function createCmuxReviewSubagentRunner(): (
	launch: ReviewSubagentLaunch,
	signal?: AbortSignal,
) => Promise<ReviewSubagentResult> {
	const surfaces = cmux.createSurfaceManager();
	return (launch, signal) => runReviewSubagentWithBackend(launch, cmuxBackend(surfaces.createSurface), signal);
}

function cmuxBackend(createSurface: SubagentBackendAdapter["createSurface"]): SubagentBackendAdapter {
	return {
		isAvailable: cmux.isCmuxAvailable,
		unavailableMessage: cmux.cmuxUnavailableMessage,
		createSurface,
		sendLongCommand: cmux.sendLongCommand,
		pollForExit: cmux.pollForExit,
		closeSurface: cmux.closeSurface,
	};
}

export async function runHerdrSubagent(launch: SubagentLaunch, signal?: AbortSignal): Promise<SubagentResult> {
	return runSubagentWithBackend(launch, herdrBackend(), signal);
}

export async function runHerdrReviewSubagent(
	launch: ReviewSubagentLaunch,
	signal?: AbortSignal,
): Promise<ReviewSubagentResult> {
	return runReviewSubagentWithBackend(launch, herdrBackend(), signal);
}

function herdrBackend(): SubagentBackendAdapter {
	return {
		isAvailable: herdr.isHerdrAvailable,
		unavailableMessage: herdr.herdrUnavailableMessage,
		createSurface: herdr.createSurface,
		sendLongCommand: herdr.sendLongCommand,
		pollForExit: herdr.pollForExit,
		closeSurface: herdr.closeSurface,
	};
}

async function runSubagentWithBackend(
	launch: SubagentLaunch,
	backend: SubagentBackendAdapter,
	signal?: AbortSignal,
	bootstrap: SubagentBootstrapOptions = {},
): Promise<SubagentResult> {
	return runChildSubagentWithBackend(launch, backend, "step", signal, bootstrap);
}

async function runReviewSubagentWithBackend(
	launch: ReviewSubagentLaunch,
	backend: SubagentBackendAdapter,
	signal?: AbortSignal,
	bootstrap: SubagentBootstrapOptions = {},
): Promise<ReviewSubagentResult> {
	return runChildSubagentWithBackend(launch, backend, "review", signal, bootstrap);
}

async function runChildSubagentWithBackend(
	launch: SubagentLaunch,
	backend: SubagentBackendAdapter,
	mode: "step",
	signal?: AbortSignal,
	bootstrap?: SubagentBootstrapOptions,
): Promise<SubagentResult>;
async function runChildSubagentWithBackend(
	launch: ReviewSubagentLaunch,
	backend: SubagentBackendAdapter,
	mode: "review",
	signal?: AbortSignal,
	bootstrap?: SubagentBootstrapOptions,
): Promise<ReviewSubagentResult>;
async function runChildSubagentWithBackend(
	launch: SubagentLaunch | ReviewSubagentLaunch,
	backend: SubagentBackendAdapter,
	mode: "step" | "review",
	signal?: AbortSignal,
	bootstrap: SubagentBootstrapOptions = {},
): Promise<SubagentResult | ReviewSubagentResult> {
	if (!backend.isAvailable()) {
		if (mode === "review") {
			throw new ReviewSubagentUnavailableError(`Independent review backend is unavailable. ${backend.unavailableMessage()}`);
		}
		throw new Error(backend.unavailableMessage());
	}

	const childCwd = mode === "review" ? resolveReviewCwd(launch.cwd) : launch.cwd;
	const rootDir = join(tmpdir(), "anvil");
	mkdirSync(rootDir, { recursive: true, mode: 0o700 });
	chmodSync(rootDir, 0o700);
	const workDir = join(rootDir, launch.runId);
	mkdirSync(workDir, { recursive: true, mode: 0o700 });
	chmodSync(workDir, 0o700);
	// A run may execute repeated/concurrent checks for the same step (notably forEach).
	// Wall-clock timestamps alone can collide, causing sessions and verdict sidecars to
	// overwrite one another. Keep every child invocation in a collision-resistant namespace.
	const base = join(workDir, `${sanitizeForFilename(launch.stepId)}-${Date.now().toString(36)}-${randomUUID()}`);
	const taskFile = `${base}.task.md`;
	writeFileSync(taskFile, launch.task, { encoding: "utf8", mode: 0o600 });

	const timeoutMs = launch.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
	const readyTimeoutMs = bootstrap.readyTimeoutMs ?? SUBAGENT_READY_TIMEOUT_MS;
	const attempts = bootstrap.attempts ?? SUBAGENT_BOOTSTRAP_ATTEMPTS;
	const retryDelayMs = bootstrap.retryDelayMs ?? SUBAGENT_BOOTSTRAP_RETRY_DELAY_MS;
	const transportFailureLimit = bootstrap.transportFailureLimit ?? SUBAGENT_TRANSPORT_FAILURE_LIMIT;
	const transportFailureWindowMs = bootstrap.transportFailureWindowMs ?? SUBAGENT_TRANSPORT_FAILURE_WINDOW_MS;
	const transportRetryDelayMs = bootstrap.transportRetryDelayMs ?? SUBAGENT_TRANSPORT_RETRY_DELAY_MS;
	const cleanupTimeoutMs = bootstrap.cleanupTimeoutMs ?? SUBAGENT_CLEANUP_TIMEOUT_MS;
	const now = bootstrap.now ?? Date.now;
	const deadline = Date.now() + timeoutMs;
	const transportFailureTimes: number[] = [];
	let bootstrapAttempt = 1;
	let sessionAttempt = 0;
	for (;;) {
		throwIfAborted(signal);
		sessionAttempt += 1;
		const sessionFile = `${base}-attempt-${sessionAttempt}.jsonl`;
		const sentinelNonce = newSentinelNonce();
		const reviewIdentity = mode === "review" ? prepareReviewIdentity(workDir, launch.model) : undefined;
		const commandBuilder = mode === "review" ? buildReviewSubagentBootstrapCommand : buildSubagentBootstrapCommand;
		const command = commandBuilder({
			cwd: childCwd,
			sessionFile,
			taskFile,
			model: launch.model,
			thinkingLevel: launch.thinkingLevel,
			sentinelNonce,
			reviewAgentDir: reviewIdentity?.agentDir,
			reviewHomeDir: reviewIdentity?.homeDir,
		});
		const createdSurfaces = new Set<string>();
		const cleanupPromises = new Map<string, Promise<void>>();
		let launchFailed = false;
		const cleanupCreatedSurface = (surface: string): Promise<void> => {
			createdSurfaces.add(surface);
			let cleanup = cleanupPromises.get(surface);
			if (!cleanup) {
				cleanup = closeSurfaceAfterRun(backend, surface, cleanupTimeoutMs);
				cleanupPromises.set(surface, cleanup);
			}
			return cleanup;
		};
		let surface: string;
		try {
			surface = await runLaunchOperation(
				(operationSignal) =>
					backend.createSurface(launch.name, operationSignal, (created) => {
						createdSurfaces.add(created);
						if (launchFailed) void cleanupCreatedSurface(created);
					}),
				deadline,
				timeoutMs,
				signal,
				(created) => cleanupCreatedSurface(created),
			);
			createdSurfaces.add(surface);
		} catch (error) {
			launchFailed = true;
			await Promise.all([...createdSurfaces].map(cleanupCreatedSurface));
			removeReviewIdentity(reviewIdentity);
			if (mode === "review") throw reviewInfrastructureError(error, "backend launch", timeoutMs, signal, backend);
			throw error;
		}
		let retryBootstrap = false;
		let retryTransportFailure = false;
		try {
			try {
				await runLaunchOperation(
					(operationSignal) => backend.sendLongCommand(surface, command, `${base}-attempt-${sessionAttempt}.sh`, operationSignal),
					deadline,
					timeoutMs,
					signal,
				);
			} catch (error) {
				if (mode === "review") throw reviewInfrastructureError(error, "command launch", timeoutMs, signal);
				throw error;
			}
			const remainingForReady = deadline - Date.now();
			if (remainingForReady <= 0) throw new Error(`Subagent timed out after ${timeoutMs}ms`);
			await waitForSubagentReady(sessionFile, Math.min(readyTimeoutMs, remainingForReady), signal);

			const remainingForExit = deadline - Date.now();
			if (remainingForExit <= 0) throw new Error(`Subagent timed out after ${timeoutMs}ms`);
			let exit: SubagentExit;
			try {
				exit = await backend.pollForExit(surface, sessionFile, signal, undefined, remainingForExit, sentinelNonce);
			} catch (error) {
				if (mode === "review") throw reviewInfrastructureError(error, "completion wait", timeoutMs, signal);
				throw error;
			}
			if (await isRetryableSubagentTransportFailure(sessionFile, exit)) {
				const failureTime = now();
				while (transportFailureTimes[0] !== undefined && failureTime - transportFailureTimes[0] >= transportFailureWindowMs) {
					transportFailureTimes.shift();
				}
				transportFailureTimes.push(failureTime);
				if (transportFailureTimes.length >= transportFailureLimit) {
					const errorMessage = `Subagent encountered ${transportFailureLimit} provider transport failures within ${formatDuration(transportFailureWindowMs)}.`;
					if (mode === "review") throw new Error(errorMessage);
					return { summary: errorMessage, errorMessage, sessionFile, exitCode: exit.exitCode };
				}
				retryTransportFailure = true;
			} else if (mode === "review") {
				if (exit.exitCode !== 0) {
					throw new Error(`Independent review subagent exited with code ${exit.exitCode}; failure details omitted.`);
				}
				const verdict = await readIndependentReviewVerdict(sessionFile, (launch as ReviewSubagentLaunch).checkId);
				return { ...verdict, sessionFile, exitCode: exit.exitCode };
			} else {
				const result = await summarizeSubagentExit(sessionFile, exit);
				return { ...result, sessionFile, exitCode: exit.exitCode };
			}
		} catch (error) {
			if (!(error instanceof SubagentReadyTimeoutError) || bootstrapAttempt === attempts) throw error;
			retryBootstrap = true;
		} finally {
			createdSurfaces.add(surface);
			await Promise.all([...createdSurfaces].map(cleanupCreatedSurface));
			removeReviewIdentity(reviewIdentity);
		}
		if (retryBootstrap) {
			bootstrapAttempt += 1;
			await sleep(retryDelayMs, signal);
		} else if (retryTransportFailure) {
			bootstrapAttempt = 1;
			await sleep(transportRetryDelayMs, signal);
		}
	}

}
/* v8 ignore stop */

async function isRetryableSubagentTransportFailure(sessionFile: string, exit: SubagentExit): Promise<boolean> {
	if (exit.exitCode !== 1) return false;
	if (exit.errorMessage === SUBAGENT_PROVIDER_ERROR_MESSAGE) return true;

	let handle;
	try {
		handle = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile()) return false;
		const bytesToRead = Math.min(stat.size, MAX_SUBAGENT_SESSION_SCAN_BYTES);
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, stat.size - bytesToRead);
		const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index];
			if (!line?.trim()) continue;
			try {
				const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown }; diagnostics?: unknown };
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				return Array.isArray(entry.diagnostics) && entry.diagnostics.some(
					(diagnostic) =>
						typeof diagnostic === "object" &&
						diagnostic !== null &&
						(diagnostic as { type?: unknown }).type === "provider_transport_failure",
				);
			} catch {
				continue;
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}

function formatDuration(durationMs: number): string {
	return durationMs % 60_000 === 0 ? `${durationMs / 60_000} minutes` : `${durationMs}ms`;
}

function resolveReviewCwd(cwd: string): string {
	try {
		const canonical = realpathSync.native(cwd);
		if (!statSync(canonical).isDirectory() || isSensitiveReviewPath(canonical)) throw new Error("invalid cwd");
		return canonical;
	} catch {
		throw new Error("Independent review cwd is unavailable.");
	}
}

function reviewInfrastructureError(
	error: unknown,
	phase: "backend launch" | "command launch" | "completion wait",
	timeoutMs: number,
	signal?: AbortSignal,
	backend?: SubagentBackendAdapter,
): Error {
	if (error instanceof AnvilAbortError) return error;
	if (signal?.aborted) return new AnvilAbortError();
	if (error instanceof ReviewSubagentUnavailableError) return error;
	if (error instanceof Error && error.message === `Subagent timed out after ${timeoutMs}ms`) {
		return new Error(`Independent review subagent timed out after ${timeoutMs}ms.`);
	}
	if (phase === "backend launch" && backend && !backend.isAvailable()) {
		return new ReviewSubagentUnavailableError(`Independent review backend is unavailable. ${backend.unavailableMessage()}`);
	}
	return new Error(`Independent review subagent ${phase} failed; details omitted.`);
}

/* v8 ignore next -- only used by ignored real-process launcher. */
function sanitizeForFilename(value: string): string {
	return value.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}

export const __testing__ = {
	runSubagentWithBackend,
	runReviewSubagentWithBackend,
	prepareReviewIdentity,
	removeReviewIdentity,
};

function runLaunchOperation<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	deadline: number,
	timeoutMs: number,
	signal?: AbortSignal,
	onLateResolve?: (value: T) => void | Promise<void>,
): Promise<T> {
	throwIfAborted(signal);
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return Promise.reject(new Error(`Subagent timed out after ${timeoutMs}ms`));

	const controller = new AbortController();
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			controller.abort();
			callback();
		};
		const onAbort = () => finish(() => reject(new AnvilAbortError()));
		const timer = setTimeout(
			() => finish(() => reject(new Error(`Subagent timed out after ${timeoutMs}ms`))),
			remainingMs,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		operation(controller.signal).then(
			(value) => {
				if (settled) {
					void Promise.resolve(onLateResolve?.(value)).catch(() => undefined);
					return;
				}
				finish(() => resolve(value));
			},
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

async function closeSurfaceAfterRun(
	backend: SubagentBackendAdapter,
	surface: string,
	timeoutMs: number,
): Promise<void> {
	try {
		await runLaunchOperation(
			(cleanupSignal) => backend.closeSurface(surface, cleanupSignal),
			Date.now() + timeoutMs,
			timeoutMs,
		);
	} catch {
		// Cleanup is best effort and must not replace the original subagent result.
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new AnvilAbortError());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(new AnvilAbortError());
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
