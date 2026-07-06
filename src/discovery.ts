import { readdir } from "node:fs/promises";
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

export async function discoverWorkflows(options: AnvilPathOptions = {}): Promise<DiscoveredWorkflow[]> {
	const dirs = getWorkflowDirs(options);
	const user = await loadWorkflowDir(dirs.user, "user");
	const project = await loadWorkflowDir(dirs.project, "project");

	const byName = new Map<string, DiscoveredWorkflow>();
	for (const result of [...user, ...project]) {
		byName.set(result.name, result);
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
