import { execFile, spawn } from "node:child_process";
import { constants, type Dir } from "node:fs";
import { open, opendir, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface DarwinDescriptorExecutionOptions {
	encoding: "utf8";
	killSignal: "SIGKILL";
	maxBuffer: number;
	signal: AbortSignal;
	timeout: number;
}

type DarwinDescriptorExecutor = (
	file: string,
	args: string[],
	options: DarwinDescriptorExecutionOptions,
) => Promise<{ stdout: string }>;

let executeDarwinDescriptorCommand = execFileAsync as unknown as DarwinDescriptorExecutor;
let beforeDirectoryEnumeration: (() => void | Promise<void>) | undefined;

export const MAX_REVIEW_READ_BYTES = 256 * 1024;
export const MAX_REVIEW_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_REVIEW_DIRECTORY_ENTRIES = 10_000;
export const MAX_REVIEW_SEARCH_FILES = 1_000;
export const MAX_REVIEW_SEARCH_BYTES = 16 * 1024 * 1024;
const DEFAULT_RESULT_LIMIT = 200;
const MAX_RESULT_LIMIT = 500;
const MAX_LINE_LENGTH = 1_000;
const DESCRIPTOR_VALIDATION_BATCH_SIZE = 32;
export const MAX_DARWIN_DIRECTORY_SUBPROCESSES = 8;
export const MAX_DARWIN_DIRECTORY_ENTRIES_PER_SUBPROCESS = Math.ceil(
	MAX_REVIEW_DIRECTORY_ENTRIES / MAX_DARWIN_DIRECTORY_SUBPROCESSES,
);
export const DARWIN_DESCRIPTOR_VALIDATION_TIMEOUT_MS = 2_000;
const DARWIN_DIRECTORY_READ_TIMEOUT_MS = 2_000;
const MAX_DARWIN_DIRECTORY_ENTRY_BYTES = 520;
const MAX_DARWIN_DIRECTORY_OUTPUT_BYTES = MAX_REVIEW_DIRECTORY_ENTRIES * MAX_DARWIN_DIRECTORY_ENTRY_BYTES;
const DARWIN_DIRECTORY_READER = String.raw`
use strict;
use warnings;
my $limit = int($ARGV[0]);
# fchdir is syscall 13 in Darwin's stable BSD syscall ABI. stdin is the
# validated directory descriptor inherited directly from the parent.
syscall(13, 0) == 0 or exit 2;
opendir(my $directory, ".") or exit 2;
my $count = 0;
while (1) {
	$! = 0;
	my $name = readdir($directory);
	if (!defined($name)) {
		exit 2 if $!;
		last;
	}
	next if $name eq "." || $name eq "..";
	my @metadata = lstat($name);
	exit 2 unless @metadata;
	$count += 1;
	exit 3 if $count > $limit;
	my $type = $metadata[2] & 0170000;
	my $kind = $type == 0040000 ? "d" : $type == 0100000 ? "f" : $type == 0120000 ? "l" : "o";
	print $kind, "\t", unpack("H*", $name), "\n";
}
`;

const SENSITIVE_DIRECTORY_NAMES = new Set([
	".aws",
	".azure",
	".git",
	".gnupg",
	".kube",
	".ssh",
]);
const SENSITIVE_FILE_PATTERNS = [
	/^\.env(?:\..*)?$/iu,
	/^\.envrc(?:\..*)?$/iu,
	/^\.netrc$/iu,
	/^\.npmrc$/iu,
	/^\.pypirc$/iu,
	/^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/iu,
	/(?:^|[._-])credentials?(?:[._-]|$)/iu,
	/(?:^|[._-])secrets?(?:[._-]|$)/iu,
	/\.(?:key|p12|pfx|pem)$/iu,
];

export class ReviewFileAccessError extends Error {
	constructor(message = "Review filesystem access denied.") {
		super(message);
		this.name = "ReviewFileAccessError";
	}
}

class ReviewTraversalBudget {
	private darwinDirectorySubprocesses = 0;
	private darwinDirectoryEntries = 0;

	claimDarwinDirectorySubprocess(requestedEntries = MAX_REVIEW_DIRECTORY_ENTRIES): number {
		if (this.darwinDirectorySubprocesses >= MAX_DARWIN_DIRECTORY_SUBPROCESSES) {
			throw new ReviewFileAccessError("Review directory traversal reached its subprocess limit.");
		}
		const remainingEntries = MAX_REVIEW_DIRECTORY_ENTRIES - this.darwinDirectoryEntries;
		if (remainingEntries <= 0) {
			throw new ReviewFileAccessError("Review directory traversal reached its entry limit.");
		}
		const grantedEntries = Math.min(
			remainingEntries,
			MAX_DARWIN_DIRECTORY_ENTRIES_PER_SUBPROCESS,
			Math.max(1, Math.trunc(requestedEntries)),
		);
		this.darwinDirectorySubprocesses += 1;
		this.darwinDirectoryEntries += grantedEntries;
		return grantedEntries;
	}

	get claimedDarwinDirectorySubprocesses(): number {
		return this.darwinDirectorySubprocesses;
	}

	get claimedDarwinDirectoryEntries(): number {
		return this.darwinDirectoryEntries;
	}
}

export interface ReviewReadOptions {
	offset?: number;
	limit?: number;
}

export interface ReviewSearchOptions {
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	limit?: number;
}

/**
 * Read-only filesystem facade for independent reviewers. Every operation is
 * rooted at one canonical workflow cwd, rejects secret-like paths, never
 * follows directory-entry symlinks while traversing, and bounds persisted tool
 * output.
 */
export class ReviewFileSystem {
	private constructor(readonly root: string) {}

	static async create(root: string): Promise<ReviewFileSystem> {
		let canonicalRoot: string;
		try {
			canonicalRoot = await realpath(root);
			if (!(await stat(canonicalRoot)).isDirectory() || isSensitiveReviewPath(canonicalRoot)) {
				throw new ReviewFileAccessError();
			}
		} catch (error) {
			if (error instanceof ReviewFileAccessError) throw error;
			throw new ReviewFileAccessError("Independent review cwd is unavailable.");
		}
		return new ReviewFileSystem(canonicalRoot);
	}

	async read(path: string, options: ReviewReadOptions = {}, signal?: AbortSignal): Promise<string> {
		const file = await this.resolveExisting(path);
		const { text } = await readBoundedTextFile(this.root, file, MAX_REVIEW_READ_BYTES, signal);
		const lines = text.split("\n");
		const offset = clampInteger(options.offset, 1, Number.MAX_SAFE_INTEGER, 1);
		const limit = clampInteger(options.limit, 1, MAX_RESULT_LIMIT, DEFAULT_RESULT_LIMIT);
		const selected = lines.slice(offset - 1, offset - 1 + limit);
		const rendered = selected.map((line, index) => `${offset + index}: ${truncateLine(line)}`).join("\n");
		return boundOutput(rendered || "(empty file)");
	}

	async ls(path = ".", limit = DEFAULT_RESULT_LIMIT, signal?: AbortSignal): Promise<string> {
		const directory = await this.resolveExisting(path);
		const entries = await readDirectoryEntries(
			this.root,
			directory,
			MAX_REVIEW_DIRECTORY_ENTRIES,
			signal,
			new ReviewTraversalBudget(),
		);
		const boundedLimit = clampInteger(limit, 1, MAX_RESULT_LIMIT, DEFAULT_RESULT_LIMIT);
		const visible = entries
			.filter((entry) => !containsUnsafeText(entry.name) && !isSensitiveComponent(entry.name))
			.sort((left, right) => left.name.localeCompare(right.name))
			.slice(0, boundedLimit)
			.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`);
		return boundOutput(visible.join("\n") || "(empty directory)");
	}

	async find(
		pattern: string,
		options: Omit<ReviewSearchOptions, "ignoreCase"> = {},
		signal?: AbortSignal,
	): Promise<string> {
		const matcher = globMatcher(pattern);
		const start = await this.resolveExisting(options.path ?? ".");
		try {
			if (!(await stat(start)).isDirectory()) throw new ReviewFileAccessError("Review path must be a directory.");
		} catch (error) {
			if (error instanceof ReviewFileAccessError) throw error;
			throw new ReviewFileAccessError("Review path is unavailable.");
		}
		const limit = clampInteger(options.limit, 1, MAX_RESULT_LIMIT, DEFAULT_RESULT_LIMIT);
		const matches: string[] = [];
		await this.walk(start, async (_absolutePath, relativePath, directory) => {
			if (matches.length >= limit) return false;
			if (matcher(relativePath) || matcher(relativePath.split("/").at(-1) ?? relativePath)) {
				matches.push(`${relativePath}${directory ? "/" : ""}`);
			}
			return matches.length < limit;
		}, signal);
		return boundOutput(matches.slice(0, limit).join("\n") || "No matching paths.");
	}

	async grep(pattern: string, options: ReviewSearchOptions = {}, signal?: AbortSignal): Promise<string> {
		if (!pattern || pattern.length > MAX_LINE_LENGTH || containsUnsafeText(pattern)) {
			throw new ReviewFileAccessError("Review search pattern is invalid.");
		}
		const start = await this.resolveExisting(options.path ?? ".");
		const glob = options.glob ? globMatcher(options.glob) : undefined;
		const limit = clampInteger(options.limit, 1, MAX_RESULT_LIMIT, DEFAULT_RESULT_LIMIT);
		const needle = options.ignoreCase ? pattern.toLocaleLowerCase() : pattern;
		const matches: string[] = [];
		let filesInspected = 0;
		let bytesInspected = 0;
		let commitMatches = Promise.resolve();
		const withinSearchBudget = () =>
			filesInspected < MAX_REVIEW_SEARCH_FILES && bytesInspected < MAX_REVIEW_SEARCH_BYTES;
		const inspect = async (absolutePath: string, relativePath: string): Promise<boolean> => {
			if (matches.length >= limit || !withinSearchBudget()) return false;
			if (glob && !glob(relativePath)) return true;
			filesInspected += 1;
			const byteAllowance = Math.min(MAX_REVIEW_READ_BYTES, MAX_REVIEW_SEARCH_BYTES - bytesInspected);
			bytesInspected += byteAllowance;
			const previousCommit = commitMatches;
			let releaseCommit: () => void = () => undefined;
			commitMatches = new Promise<void>((resolveCommit) => {
				releaseCommit = resolveCommit;
			});
			let result: Awaited<ReturnType<typeof readBoundedTextFile>>;
			try {
				result = await readBoundedTextFile(this.root, absolutePath, byteAllowance, signal);
			} catch {
				await previousCommit;
				releaseCommit();
				return withinSearchBudget();
			}
			await previousCommit;
			bytesInspected -= byteAllowance - result.bytesRead;
			try {
				for (const [index, line] of result.text.split("\n").entries()) {
					const haystack = options.ignoreCase ? line.toLocaleLowerCase() : line;
					if (!haystack.includes(needle)) continue;
					matches.push(`${relativePath}:${index + 1}:${truncateLine(line)}`);
					if (matches.length >= limit) return false;
				}
				return withinSearchBudget();
			} finally {
				releaseCommit();
			}
		};

		let startStat;
		try {
			startStat = await stat(start);
		} catch {
			throw new ReviewFileAccessError("Review path is unavailable.");
		}
		if (startStat.isFile()) {
			await inspect(start, toWorkspacePath(this.root, start));
		} else if (startStat.isDirectory()) {
			await this.walk(
				start,
				async (absolutePath, relativePath, directory) => directory ? true : inspect(absolutePath, relativePath),
				signal,
			);
		} else {
			throw new ReviewFileAccessError("Review path must be a regular file or directory.");
		}
		return boundOutput(matches.slice(0, limit).join("\n") || "No matches.");
	}

	private async resolveExisting(input: string): Promise<string> {
		if (!input || containsUnsafeText(input)) throw new ReviewFileAccessError();
		const candidate = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
		if (!isWithinRoot(this.root, candidate) || hasSensitiveRelativePath(this.root, candidate)) {
			throw new ReviewFileAccessError();
		}

		let canonical: string;
		try {
			canonical = await realpath(candidate);
		} catch {
			throw new ReviewFileAccessError("Review path is unavailable.");
		}
		if (!isWithinRoot(this.root, canonical) || hasSensitiveRelativePath(this.root, canonical)) {
			throw new ReviewFileAccessError();
		}
		return canonical;
	}

	private async walk(
		start: string,
		visit: (absolutePath: string, relativePath: string, directory: boolean) => Promise<boolean>,
		signal?: AbortSignal,
	): Promise<void> {
		const pending = [start];
		const traversalBudget = new ReviewTraversalBudget();
		let inspected = 0;
		while (pending.length > 0) {
			pending.sort((left, right) => left.localeCompare(right));
			const directoryPaths = pending.splice(0, DESCRIPTOR_VALIDATION_BATCH_SIZE);
			const openedResults = await Promise.allSettled(directoryPaths.map(async (path) => ({
				path,
				handle: await openValidatedDirectory(this.root, path, signal, traversalBudget),
			})));
			const failedOpen = openedResults.find((result) => result.status === "rejected");
			if (failedOpen?.status === "rejected") {
				await Promise.all(openedResults.map(async (result) => {
					if (result.status === "fulfilled") await result.value.handle.close().catch(() => undefined);
				}));
				throw failedOpen.reason;
			}
			const directories = openedResults.map((result) => {
				if (result.status !== "fulfilled") throw new ReviewFileAccessError();
				return result.value;
			});
			const candidates: Array<{ absolutePath: string; relativePath: string; directory: boolean }> = [];
			let traversalIncomplete = false;
			for (const [directoryIndex, opened] of directories.entries()) {
				try {
					while (inspected < MAX_REVIEW_DIRECTORY_ENTRIES) {
						const entry = await opened.handle.read();
						if (!entry) break;
						inspected += 1;
						if (containsUnsafeText(entry.name) || isSensitiveComponent(entry.name) || entry.isSymbolicLink()) continue;
						const absolutePath = resolve(opened.path, entry.name);
						if (!isWithinRoot(this.root, absolutePath)) continue;
						if (!entry.isDirectory() && !entry.isFile()) continue;
						candidates.push({
							absolutePath,
							relativePath: toWorkspacePath(this.root, absolutePath),
							directory: entry.isDirectory(),
						});
					}
					if (inspected >= MAX_REVIEW_DIRECTORY_ENTRIES) {
						traversalIncomplete = traversalIncomplete || directoryIndex < directories.length - 1 ||
							pending.length > 0 || await opened.handle.read() !== null;
					}
				} finally {
					await opened.handle.close().catch(() => undefined);
				}
			}
			if (traversalIncomplete) {
				throw new ReviewFileAccessError("Review directory traversal reached its entry limit.");
			}
			candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
			for (let index = 0; index < candidates.length; index += DESCRIPTOR_VALIDATION_BATCH_SIZE) {
				const batch = candidates.slice(index, index + DESCRIPTOR_VALIDATION_BATCH_SIZE);
				const keepWalking = await Promise.all(batch.map(async (candidate) => {
					const keepGoing = await visit(candidate.absolutePath, candidate.relativePath, candidate.directory);
					if (candidate.directory && keepGoing) pending.push(candidate.absolutePath);
					return keepGoing;
				}));
				if (keepWalking.some((keepGoing) => !keepGoing)) return;
			}
		}
	}
}

export function isSensitiveReviewPath(path: string): boolean {
	return path.split(/[\\/]+/u).filter(Boolean).some(isSensitiveComponent);
}

function isSensitiveComponent(component: string): boolean {
	return SENSITIVE_DIRECTORY_NAMES.has(component.toLocaleLowerCase()) ||
		SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(component));
}

function hasSensitiveRelativePath(root: string, path: string): boolean {
	const local = relative(root, path);
	return isSensitiveReviewPath(root) || (local !== "" && isSensitiveReviewPath(local));
}

function isWithinRoot(root: string, path: string): boolean {
	const local = relative(root, path);
	return local === "" || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

function toWorkspacePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/") || ".";
}

interface ReviewDirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

interface ValidatedDirectory {
	read(): Promise<ReviewDirectoryEntry | null>;
	close(): Promise<void>;
}

async function openValidatedDirectory(
	root: string,
	path: string,
	signal?: AbortSignal,
	traversalBudget = new ReviewTraversalBudget(),
): Promise<ValidatedDirectory> {
	let guard: FileHandle | undefined;
	let directory: Dir | undefined;
	try {
		const before = await stat(path);
		if (!before.isDirectory()) throw new ReviewFileAccessError("Review path must be a directory.");
		guard = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = await guard.stat();
		if (!sameFile(before, opened)) throw new ReviewFileAccessError();
		await validateOpenedHandle(root, guard, signal);
		await beforeDirectoryEnumeration?.();

		// Readdir must open an alias for the exact descriptor validated above.
		// Reopening `path` would let an attacker replace an intermediate directory
		// with a symlink after the identity check and enumerate an external tree.
		if (process.platform === "darwin") {
			// Node cannot securely reopen an already-validated Darwin directory
			// descriptor, so enumeration uses a small fchdir helper. Keep that
			// workaround explicitly bounded for adversarial deep/wide trees.
			// Reserve both the helper and its output allowance from the traversal-
			// wide budget before launch. Without this reservation, every helper
			// could independently buffer the full 10,000-entry allowance.
			const entryLimit = traversalBudget.claimDarwinDirectorySubprocess(MAX_REVIEW_DIRECTORY_ENTRIES);
			const entries = await readDarwinDirectoryEntries(guard, entryLimit, signal);
			const activeGuard = guard;
			let index = 0;
			return {
				read: async () => entries[index++] ?? null,
				close: () => activeGuard.close(),
			};
		}

		const descriptorPath = directoryDescriptorPath(guard.fd);
		const openedPath = await realpath(descriptorPath);
		if (!isWithinRoot(root, openedPath) || hasSensitiveRelativePath(root, openedPath)) {
			throw new ReviewFileAccessError();
		}
		directory = await opendir(descriptorPath);
		const activeDirectory = directory;
		const activeGuard = guard;
		return {
			read: () => activeDirectory.read(),
			close: async () => {
				await activeDirectory.close().catch(() => undefined);
				await activeGuard.close().catch(() => undefined);
			},
		};
	} catch (error) {
		await directory?.close().catch(() => undefined);
		await guard?.close().catch(() => undefined);
		if (error instanceof ReviewFileAccessError) throw error;
		throw new ReviewFileAccessError("Review directory is unavailable.");
	}
}

async function readDirectoryEntries(
	root: string,
	path: string,
	limit: number,
	signal?: AbortSignal,
	traversalBudget = new ReviewTraversalBudget(),
): Promise<ReviewDirectoryEntry[]> {
	const directory = await openValidatedDirectory(root, path, signal, traversalBudget);
	const entries: ReviewDirectoryEntry[] = [];
	try {
		while (entries.length < limit) {
			const entry = await directory.read();
			if (!entry) break;
			entries.push(entry);
		}
		if (entries.length >= limit && await directory.read() !== null) {
			throw new ReviewFileAccessError("Review directory traversal reached its entry limit.");
		}
	} finally {
		await directory.close();
	}
	return entries;
}

async function readDarwinDirectoryEntries(
	handle: FileHandle,
	limit: number,
	signal?: AbortSignal,
): Promise<ReviewDirectoryEntry[]> {
	const child = spawn("/usr/bin/perl", ["-e", DARWIN_DIRECTORY_READER, String(limit)], {
		env: { PATH: "/usr/bin:/bin" },
		killSignal: "SIGKILL",
		signal,
		stdio: [handle.fd, "pipe", "ignore"],
		timeout: DARWIN_DIRECTORY_READ_TIMEOUT_MS,
	});
	const chunks: Buffer[] = [];
	const outputLimit = Math.min(
		MAX_DARWIN_DIRECTORY_OUTPUT_BYTES,
		Math.max(1, Math.trunc(limit)) * MAX_DARWIN_DIRECTORY_ENTRY_BYTES,
	);
	let outputBytes = 0;
	let failure: Error | undefined;
	return new Promise<ReviewDirectoryEntry[]>((resolveRequest, rejectRequest) => {
		child.stdout!.on("data", (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > outputLimit) {
				failure = new ReviewFileAccessError("Review directory output exceeded its limit.");
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		});
		child.on("error", (error) => {
			failure = error;
		});
		child.on("close", (code) => {
			if (code === 3) {
				rejectRequest(new ReviewFileAccessError("Review directory traversal reached its entry limit."));
				return;
			}
			if (failure || code !== 0) {
				rejectRequest(new ReviewFileAccessError("Review directory cannot be enumerated securely."));
				return;
			}
			try {
				resolveRequest(parseDarwinDirectoryEntries(Buffer.concat(chunks).toString("ascii")));
			} catch {
				rejectRequest(new ReviewFileAccessError("Review directory returned invalid entries."));
			}
		});
	});
}

function parseDarwinDirectoryEntries(output: string): ReviewDirectoryEntry[] {
	return output.split("\n").filter(Boolean).map((line) => {
		const separator = line.indexOf("\t");
		const kind = line.slice(0, separator);
		const encodedName = line.slice(separator + 1);
		if (separator !== 1 || !/^[0-9a-f]*$/u.test(encodedName) || encodedName.length % 2 !== 0) {
			throw new ReviewFileAccessError();
		}
		const name = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encodedName, "hex"));
		return {
			name,
			isDirectory: () => kind === "d",
			isFile: () => kind === "f",
			isSymbolicLink: () => kind === "l",
		};
	});
}

function directoryDescriptorPath(fd: number, platform = process.platform): string {
	if (platform === "linux") return `/proc/self/fd/${fd}`;
	throw new ReviewFileAccessError("Secure review directory access is unavailable on this platform.");
}

function sameFile(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedTextFile(
	root: string,
	path: string,
	byteLimit = MAX_REVIEW_READ_BYTES,
	signal?: AbortSignal,
): Promise<{ text: string; bytesRead: number }> {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const fileStat = await handle.stat();
		await validateOpenedHandle(root, handle, signal);
		if (!fileStat.isFile()) throw new ReviewFileAccessError("Review path must be a regular file.");
		const bytesToRead = Math.min(fileStat.size, MAX_REVIEW_READ_BYTES, Math.max(0, byteLimit));
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.includes(0)) throw new ReviewFileAccessError("Binary files cannot be reviewed.");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new ReviewFileAccessError("Non-UTF-8 files cannot be reviewed.");
		}
		return {
			text: fileStat.size > bytesToRead ? `${text}\n[File truncated]` : text,
			bytesRead,
		};
	} catch (error) {
		if (error instanceof ReviewFileAccessError) throw error;
		throw new ReviewFileAccessError("Review file is unavailable.");
	} finally {
		await handle?.close();
	}
}

export async function validateOpenedHandle(root: string, handle: FileHandle, signal?: AbortSignal): Promise<void> {
	const openedPath = await openedHandlePath(handle, signal);
	if (!isWithinRoot(root, openedPath) || hasSensitiveRelativePath(root, openedPath)) {
		throw new ReviewFileAccessError();
	}
}

/**
 * Resolve the object behind an already-open descriptor. Validation must be
 * descriptor-based: validating the input pathname again would allow an
 * attacker to swap any intermediate directory to a symlink, open an external
 * object, and restore the original directory before the second check.
 */
async function openedHandlePath(handle: FileHandle, signal?: AbortSignal): Promise<string> {
	if (process.platform === "linux") {
		try {
			return await realpath(`/proc/self/fd/${handle.fd}`);
		} catch {
			throw new ReviewFileAccessError("Review file descriptor cannot be validated.");
		}
	}
	if (process.platform === "darwin") {
		return resolveDarwinOpenedHandlePath(handle.fd, signal);
	}
	throw new ReviewFileAccessError("Secure review filesystem access is unavailable on this platform.");
}

interface DarwinDescriptorRequest {
	fd: number;
	signal?: AbortSignal;
	resolve: (path: string) => void;
	reject: (error: ReviewFileAccessError) => void;
}

let darwinDescriptorQueue: DarwinDescriptorRequest[] = [];
let darwinDescriptorFlushScheduled = false;
let darwinDescriptorValidationSpawnCount = 0;

/**
 * Coalesce descriptors opened in one traversal batch into one lsof snapshot.
 * lsof is the only portable descriptor-to-path primitive available to Node on
 * Darwin, and invoking it for every reviewed file makes large searches
 * prohibitively expensive.
 */
function resolveDarwinOpenedHandlePath(fd: number, signal?: AbortSignal): Promise<string> {
	return new Promise<string>((resolveRequest, rejectRequest) => {
		if (signal?.aborted) {
			rejectRequest(new ReviewFileAccessError("Review file descriptor validation was cancelled."));
			return;
		}
		darwinDescriptorQueue.push({ fd, signal, resolve: resolveRequest, reject: rejectRequest });
		if (darwinDescriptorFlushScheduled) return;
		darwinDescriptorFlushScheduled = true;
		// File opens/stat calls finish in separate libuv callbacks. A short
		// collection window keeps one logical traversal batch in one snapshot.
		setTimeout(() => void flushDarwinDescriptorQueue(), 5);
	});
}

async function flushDarwinDescriptorQueue(): Promise<void> {
	const requests = darwinDescriptorQueue;
	darwinDescriptorQueue = [];
	darwinDescriptorFlushScheduled = false;
	if (requests.length === 0) return;

	const active = requests.filter((request) => {
		if (!request.signal?.aborted) return true;
		request.reject(new ReviewFileAccessError("Review file descriptor validation was cancelled."));
		return false;
	});
	if (active.length === 0) return;

	const subprocessController = new AbortController();
	const cancelled = new Set<DarwinDescriptorRequest>();
	const onAbort = new Map<DarwinDescriptorRequest, () => void>();
	for (const request of active) {
		if (!request.signal) continue;
		const listener = () => {
			cancelled.add(request);
			request.reject(new ReviewFileAccessError("Review file descriptor validation was cancelled."));
			if (active.every((candidate) => cancelled.has(candidate))) subprocessController.abort();
		};
		onAbort.set(request, listener);
		request.signal.addEventListener("abort", listener, { once: true });
	}

	try {
		darwinDescriptorValidationSpawnCount += 1;
		const { stdout } = await executeDarwinDescriptorCommand(
			"/usr/sbin/lsof",
			["-a", "-p", String(process.pid), "-d", active.map(({ fd }) => fd).join(","), "-Ffn"],
			{
				encoding: "utf8",
				killSignal: "SIGKILL",
				maxBuffer: Math.max(16 * 1024, active.length * 4 * 1024),
				signal: subprocessController.signal,
				timeout: DARWIN_DESCRIPTOR_VALIDATION_TIMEOUT_MS,
			},
		);
		const paths = parseDarwinDescriptorPaths(stdout);
		await Promise.all(active.map(async (request) => {
			if (cancelled.has(request)) return;
			const path = paths.get(request.fd);
			if (!path) throw new Error("missing descriptor path");
			request.resolve(await realpath(path));
		}));
	} catch {
		const error = new ReviewFileAccessError("Review file descriptor cannot be validated.");
		for (const request of active) request.reject(error);
	} finally {
		for (const [request, listener] of onAbort) request.signal?.removeEventListener("abort", listener);
	}
}

function parseDarwinDescriptorPaths(output: string): Map<number, string> {
	const paths = new Map<number, string>();
	let descriptor: number | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("f")) {
			const value = Number.parseInt(line.slice(1), 10);
			descriptor = Number.isInteger(value) ? value : undefined;
		} else if (line.startsWith("n") && descriptor !== undefined) {
			paths.set(descriptor, line.slice(1));
		}
	}
	return paths;
}

export const __testing__ = {
	createTraversalBudget: () => new ReviewTraversalBudget(),
	directoryDescriptorPath,
	getDarwinDescriptorValidationSpawnCount: () => darwinDescriptorValidationSpawnCount,
	setBeforeDirectoryEnumeration: (hook: (() => void | Promise<void>) | undefined) => {
		beforeDirectoryEnumeration = hook;
	},
	resetDarwinDescriptorValidationSpawnCount: () => {
		darwinDescriptorValidationSpawnCount = 0;
	},
	resolveDarwinOpenedHandlePath,
	setDarwinDescriptorExecutor: (executor: DarwinDescriptorExecutor) => {
		executeDarwinDescriptorCommand = executor;
	},
	resetDarwinDescriptorExecutor: () => {
		executeDarwinDescriptorCommand = execFileAsync as unknown as DarwinDescriptorExecutor;
	},
};

function globMatcher(pattern: string): (path: string) => boolean {
	if (!pattern || pattern.length > MAX_LINE_LENGTH || containsUnsafeText(pattern)) {
		throw new ReviewFileAccessError("Review path pattern is invalid.");
	}
	return (path) => matchesGlob(pattern, path);
}

/** Linear-time wildcard matching for the intentionally small `*`/`?` glob contract. */
function matchesGlob(pattern: string, path: string): boolean {
	let patternIndex = 0;
	let pathIndex = 0;
	let starIndex = -1;
	let starPathIndex = -1;
	while (pathIndex < path.length) {
		const token = pattern[patternIndex];
		if (token === "?" || token === path[pathIndex]) {
			patternIndex += 1;
			pathIndex += 1;
			continue;
		}
		if (token === "*") {
			starIndex = patternIndex;
			starPathIndex = pathIndex;
			patternIndex += 1;
			continue;
		}
		if (starIndex < 0) return false;
		patternIndex = starIndex + 1;
		starPathIndex += 1;
		pathIndex = starPathIndex;
	}
	while (pattern[patternIndex] === "*") patternIndex += 1;
	return patternIndex === pattern.length;
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function truncateLine(line: string): string {
	return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

function boundOutput(output: string): string {
	const buffer = Buffer.from(output, "utf8");
	if (buffer.byteLength <= MAX_REVIEW_TOOL_OUTPUT_BYTES) return output;
	const suffix = "\n[Output truncated]";
	const prefixBytes = MAX_REVIEW_TOOL_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8") - 3;
	return `${buffer.subarray(0, prefixBytes).toString("utf8")}${suffix}`;
}

function containsUnsafeText(value: string): boolean {
	return /[\u0000-\u001f\u007f]/u.test(value);
}
