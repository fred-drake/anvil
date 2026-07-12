import { defineWorkflow } from "anvil";

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export default defineWorkflow({
	name: "demo",
	description: "Create or update a file, then verify its contents with a retry loop.",
	defaults: {
		// Auto-detects HERDR_ENV=1 as herdr, then CMUX_SHELL_INTEGRATION=1 as cmux.
		// Use { subagent: "cmux" }, { subagent: "herdr" }, { skill: "implementer" }, or "none" to override.
		delegation: "auto",
		maxLoops: 2,
	},
	steps: [
		{
			id: "create-file",
			title: "Create the requested file",
			// Optional: start cheap, then escalate model/thinking after retries.
			// model: "cheap/model:minimal",
			// retryModelSelections: [{ retry: 1, model: "strong/model", thinkingLevel: "high" }],
			prompt: "Complete this file task: {input}",
			outputFrom: "file-exists",
			checks: [
				{
					type: "deterministic",
					id: "file-exists",
					name: "File exists",
					command: (ctx) => {
						const match = /(?:create|write)\s+(\S+)/i.exec(ctx.input);
						const file = match?.[1] ?? "/tmp/anvil-demo.txt";
						return `test -f ${shellEscape(file)} && printf '%s' ${shellEscape(file)}`;
					},
					onFail: { goto: "create-file", maxLoops: 2, feedback: true },
				},
			],
		},
		{
			id: "summarize",
			title: "Summarize the result",
			runInMain: true,
			prompt: "Summarize what was done for: {input}\n\nThe verified file path from the previous step is: {outputs.create-file}",
			checks: [
				{
					type: "agent",
					id: "summary-quality",
					// The independent review receives this step's bounded observable chat result.
					name: "Useful summary",
					prompt: "Pass if the summary clearly states what changed and any verification performed.",
					review: { subagent: "auto" },
				},
			],
		},
	],
});
