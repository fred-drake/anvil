import { defineWorkflow } from "anvil";

/**
 * Per-item fan-out pattern for small/local models.
 *
 * The plan step enumerates the files to touch and writes them, one per line, to a scratch
 * file that a deterministic check verifies is non-empty. The fan-out step then reads that
 * file mechanically and runs its prompt once per line in a fresh subagent session, so each
 * subagent gets one small, self-contained task ("write test stubs for {item}") instead of one
 * monolithic task. Retries, feedback, and model escalation all apply per item.
 */
export default defineWorkflow({
	name: "fan-out",
	description: "Enumerate files deterministically, then write test stubs for each file in its own subagent.",
	defaults: {
		delegation: "auto",
		maxLoops: 2,
	},
	steps: [
		{
			id: "plan",
			title: "List the files that need test stubs",
			prompt:
				"For this task: {input}\n\n" +
				"Write the list of source files that need test stubs to /tmp/anvil-fanout-files.txt, " +
				"one path per line and nothing else.",
			checks: [
				{
					type: "deterministic",
					id: "file-list",
					name: "Plan produced a non-empty file list",
					command: "test -s /tmp/anvil-fanout-files.txt",
					onFail: { goto: "plan", maxLoops: 2, feedback: true },
				},
			],
		},
		{
			id: "stubs",
			title: "Write unit test stubs",
			// One fresh subagent session per file — context never accumulates across items.
			delegation: { subagent: "cmux" },
			// {item} is the current line; {itemIndex} is zero-based; {itemCount} is the total.
			prompt: "Write unit test stubs for {item} (file {itemIndex} of {itemCount}). Do not implement the tests, only the stubs.",
			forEach: {
				// Enumerate mechanically from the gated plan output — no model judgment in the loop.
				items: { command: "cat /tmp/anvil-fanout-files.txt", parse: "lines" },
				// Record each item's outcome and keep going; the step fails only if every file fails.
				onItemExhausted: "continue",
			},
			checks: [
				{
					type: "deterministic",
					id: "stub-typechecks",
					name: "Stub file typechecks",
					// {item} is injected shell-safely, never interpolated as raw text.
					command: "npx tsc --noEmit {item}",
					// Inside a forEach step a goto must target this step; it retries just this item.
					onFail: { goto: "stubs", maxLoops: 1, feedback: true },
				},
			],
		},
	],
});
