import { defineWorkflow } from "anvil";

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export default defineWorkflow({
	name: "demo",
	description: "Create or update a file, then verify its contents with a retry loop.",
	defaults: {
		delegation: { skill: "implementer" },
		maxLoops: 2,
	},
	steps: [
		{
			id: "create-file",
			title: "Create the requested file",
			prompt: "Complete this file task: {input}",
			checks: [
				{
					type: "deterministic",
					id: "file-exists",
					name: "File exists",
					command: (ctx) => {
						const match = /(?:create|write)\s+(\S+)/i.exec(ctx.input);
						const file = match?.[1] ?? "/tmp/anvil-demo.txt";
						return `test -f ${shellEscape(file)}`;
					},
					onFail: { goto: "create-file", maxLoops: 2, feedback: true },
				},
			],
		},
		{
			id: "summarize",
			title: "Summarize the result",
			runInMain: true,
			prompt: "Summarize what was done for: {input}",
			checks: [
				{
					type: "agent",
					id: "summary-quality",
					name: "Useful summary",
					prompt: "Pass if the summary clearly states what changed and any verification performed.",
				},
			],
		},
	],
});
