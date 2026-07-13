import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
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

export interface PinnedWorkflowSource {
	/** Original selected path, retained only for canonical identity checks. */
	file: string;
	canonicalFile: string;
	trustedRoot: string;
	source: WorkflowSource;
	/** Last observed trusted-root input signature; advanced before each changed load attempt. */
	observedSignature: string;
}

export interface WatchedWorkflowReloadResult {
	workflow?: WorkflowDefinition;
	warning?: string;
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

	const user = markSameDirectoryCollisions(await loadWorkflowDir(dirs.user, "user"));
	const project = markSameDirectoryCollisions(await loadWorkflowDir(dirs.project, "project"));

	const projectNames = new Set(project.map((result) => result.name));
	const workflows = [...user.filter((result) => !projectNames.has(result.name)), ...project].sort(compareWorkflowResults);
	discoveryCache.set(cacheKey, { signature, workflows });
	return workflows;
}

export async function pinWorkflowSource(selected: DiscoveredWorkflow): Promise<PinnedWorkflowSource> {
	const trustedRoot = await realpath(dirname(selected.file));
	const canonicalFile = await realpath(selected.file);
	if (!isWithinRoot(canonicalFile, trustedRoot)) throw new Error("Selected workflow is outside its trusted workflow root.");
	return {
		file: selected.file,
		canonicalFile,
		trustedRoot,
		source: selected.source,
		observedSignature: await workflowRootSignature(trustedRoot),
	};
}

/** Fresh-load exactly one initially selected source after fail-closed canonical-path checks. */
export async function reloadPinnedWorkflow(pinned: PinnedWorkflowSource): Promise<WatchedWorkflowReloadResult> {
	try {
		const [currentRoot, currentFile] = await Promise.all([realpath(dirname(pinned.file)), realpath(pinned.file)]);
		if (currentRoot !== pinned.trustedRoot || currentFile !== pinned.canonicalFile || !isWithinRoot(currentFile, pinned.trustedRoot)) {
			return { warning: "selected workflow source identity changed" };
		}
		const signature = await workflowRootSignature(pinned.trustedRoot);
		if (signature === pinned.observedSignature) return {};
		// Advance on every changed attempt so an unchanged invalid edit is not repeatedly imported or warned about.
		pinned.observedSignature = signature;
		const loaded = await loadWorkflowFile(pinned.canonicalFile, pinned.source);
		if (!loaded.workflow || loaded.errors?.length) return { warning: "candidate could not be loaded or validated" };
		return { workflow: loaded.workflow };
	} catch {
		return { warning: "selected workflow source is unavailable" };
	}
}

export async function loadWorkflowFile(file: string, source: WorkflowSource): Promise<DiscoveredWorkflow> {
	let loaded: unknown;
	try {
		const jiti = createJiti(import.meta.url, {
			moduleCache: false,
			fsCache: false,
			interopDefault: true,
			alias: { "anvil": TYPES_ALIAS_PATH },
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

async function workflowRootSignature(root: string): Promise<string> {
	const parts: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(file);
			} else if (entry.isFile() && WORKFLOW_EXTENSIONS.has(extname(entry.name))) {
				const info = await stat(file);
				parts.push(`${relative(root, file)}:${info.mtimeMs}:${info.size}`);
			}
		}
	};
	await visit(root);
	return parts.join("|");
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

function markSameDirectoryCollisions(workflows: DiscoveredWorkflow[]): DiscoveredWorkflow[] {
	const byName = new Map<string, DiscoveredWorkflow[]>();
	for (const workflow of workflows) byName.set(workflow.name, [...(byName.get(workflow.name) ?? []), workflow]);

	return workflows.map((workflow) => {
		const collisions = byName.get(workflow.name) ?? [];
		if (collisions.length <= 1 || collisions[collisions.length - 1] === workflow) return workflow;
		const winner = collisions[collisions.length - 1]!;
		return {
			...workflow,
			errors: [
				...(workflow.errors ?? []),
				`duplicate workflow name "${workflow.name}" in ${workflow.source} workflows; shadowed by ${winner.file}`,
			],
		};
	});
}

function compareWorkflowResults(a: DiscoveredWorkflow, b: DiscoveredWorkflow): number {
	return (
		a.name.localeCompare(b.name) ||
		Number(Boolean(a.errors?.length)) - Number(Boolean(b.errors?.length)) ||
		a.file.localeCompare(b.file)
	);
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

function isWithinRoot(file: string, root: string): boolean {
	const child = relative(root, file);
	return child !== "" && !child.startsWith("..") && !isAbsolute(child);
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
