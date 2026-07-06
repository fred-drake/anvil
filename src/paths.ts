import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface AnvilPathOptions {
	cwd?: string;
	homeDir?: string;
}

export interface WorkflowDirs {
	user: string;
	project: string;
}

export interface ConfigPaths {
	user: string;
	project: string;
}

export function getHomeDir(options: AnvilPathOptions = {}): string {
	return options.homeDir ?? homedir();
}

export function getProjectCwd(options: AnvilPathOptions = {}): string {
	return resolve(options.cwd ?? process.cwd());
}

export function getUserAnvilDir(options: AnvilPathOptions = {}): string {
	return join(getHomeDir(options), ".pi", "agent", "anvil");
}

export function getProjectAnvilDir(options: AnvilPathOptions = {}): string {
	return join(getProjectCwd(options), ".pi", "anvil");
}

export function getWorkflowDirs(options: AnvilPathOptions = {}): WorkflowDirs {
	return {
		user: join(getUserAnvilDir(options), "workflows"),
		project: join(getProjectAnvilDir(options), "workflows"),
	};
}

export function getConfigPaths(options: AnvilPathOptions = {}): ConfigPaths {
	return {
		user: join(getUserAnvilDir(options), "config.json"),
		project: join(getProjectAnvilDir(options), "config.json"),
	};
}

export async function ensureParentDir(file: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
}
