import { defineWorkflow } from "anvil";

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export default defineWorkflow({
	name: "demo",
	description: "Create or update a file, then verify its contents with a retry loop.",
	defaults: {
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
			prompt: "Do this directly in the main agent; do not delegate it. Summarize what was done for: {input}\n\nThe verified file path from the previous step is: {outputs.create-file}\n\nCall the anvil_output tool exactly once with step_id \"summarize\" and output set to the summary.",
			checks: [
				{
					type: "agent",
					id: "summary-quality",
					name: "Useful summary",
					prompt: "Use a fresh review subagent through the active harness to assess the captured summary below. Pass if the summary clearly states what changed and any verification performed.\n\nSummary to review:\n{outputs.summarize}\n\nReport the decision through anvil_verdict using this check id.",
				},
			],
		},
	],
});
