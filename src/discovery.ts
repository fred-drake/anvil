import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { AnvilPathOptions } from "./paths.ts";
import { getWorkflowDirs } from "./paths.ts";
import type { WorkflowDefinition } from "./types.ts";
import { getWorkflowNameCandidate, validateWorkflow } from "./validate.ts";

export type WorkflowSource = "user" | "project";

export interface DiscoveredWorkflow {
	name: string;
	file: string;
	source: WorkflowSource;
	workflow?: WorkflowDefinition;
	errors?: string[];
}

const WORKFLOW_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);
const TYPES_ALIAS_PATH = fileURLToPath(new URL("./types.ts", import.meta.url));
const discoveryCache = new Map<string, { signature: string; workflows: DiscoveredWorkflow[] }>();

export interface WorkflowDiscoveryOptions extends AnvilPathOptions {
	/**
	 * Reuse mtime-based discovery results when available. Keep this enabled for
	 * keystroke-driven autocomplete, but disable it for commands that must reflect
	 * the workflow on disk even when mtimes or imported helper files make the
	 * directory signature look unchanged.
	 */
	useCache?: boolean;
}

export async function discoverWorkflows(options: WorkflowDiscoveryOptions = {}): Promise<DiscoveredWorkflow[]> {
	const dirs = getWorkflowDirs(options);
	const useCache = options.useCache !== false;
	const cacheKey = `${dirs.user}\0${dirs.project}`;
	const signature = await workflowDirsSignature(dirs);
	const cached = discoveryCache.get(cacheKey);
	if (useCache && cached?.signature === signature) return cached.workflows;

	const user = await loadWorkflowDir(dirs.user, "user");
	const project = await loadWorkflowDir(dirs.project, "project");

	const byName = new Map<string, DiscoveredWorkflow>();
	for (const result of [...user, ...project]) {
		byName.set(result.name, result);
	}

	const workflows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	discoveryCache.set(cacheKey, { signature, workflows });
	return workflows;
}

export async function loadWorkflowFile(file: string, source: WorkflowSource): Promise<DiscoveredWorkflow> {
	let loaded: unknown;
	try {
		const jiti = createJiti(import.meta.url, {
			moduleCache: false,
			fsCache: false,
			interopDefault: true,
			alias: { "pi-anvil": TYPES_ALIAS_PATH },
		});
		loaded = await jiti.import<unknown>(file, { default: true });
	} catch (error) {
		return {
			name: workflowNameFromFile(file),
			file,
			source,
			errors: [`failed to load: ${formatError(error)}`],
		};
	}

	const validation = validateWorkflow(loaded);
	if (validation.ok) {
		return { name: validation.workflow.name, file, source, workflow: validation.workflow };
	}

	return {
		name: getWorkflowNameCandidate(loaded, workflowNameFromFile(file)),
		file,
		source,
		errors: validation.errors,
	};
}

async function workflowDirsSignature(dirs: { user: string; project: string }): Promise<string> {
	const [user, project] = await Promise.all([workflowDirSignature(dirs.user), workflowDirSignature(dirs.project)]);
	return `${dirs.user}:${user}\0${dirs.project}:${project}`;
}

async function workflowDirSignature(dir: string): Promise<string> {
	try {
		const entries = await readdir(dir);
		const parts = await Promise.all(
			entries
				.filter((entry) => WORKFLOW_EXTENSIONS.has(extname(entry)))
				.sort((a, b) => a.localeCompare(b))
				.map(async (entry) => {
					const file = join(dir, entry);
					try {
						const info = await stat(file);
						return `${entry}:${info.mtimeMs}:${info.size}`;
					} catch (error) {
						return `${entry}:error:${formatError(error)}`;
					}
				}),
		);
		return parts.join("|");
	} catch (error) {
		return isNodeError(error) && error.code === "ENOENT" ? "missing" : `error:${formatError(error)}`;
	}
}

async function loadWorkflowDir(dir: string, source: WorkflowSource): Promise<DiscoveredWorkflow[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		return [
			{
				name: source,
				file: dir,
				source,
				errors: [`failed to read workflow directory: ${formatError(error)}`],
			},
		];
	}

	const files = entries
		.filter((entry) => WORKFLOW_EXTENSIONS.has(extname(entry)))
		.sort((a, b) => a.localeCompare(b))
		.map((entry) => join(dir, entry));

	return Promise.all(files.map((file) => loadWorkflowFile(file, source)));
}

function workflowNameFromFile(file: string): string {
	return basename(file, extname(file));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
