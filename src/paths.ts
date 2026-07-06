import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AnvilPathOptions {
	cwd?: string;
	homeDir?: string;
}

export interface WorkflowDirs {
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
