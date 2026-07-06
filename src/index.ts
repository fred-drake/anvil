/**
 * pi-anvil - starter pi coding agent extension.
 *
 * Load during development with:
 *   pi -e ./src/index.ts
 *
 * Or let pi discover it from this repository's .pi/extensions/ wrapper.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const anvilEchoTool = defineTool({
  name: "anvil_echo",
  label: "Anvil Echo",
  description: "Echo a message back from the pi-anvil extension scaffold.",
  parameters: Type.Object({
    message: Type.String({ description: "Message to echo back." }),
  }),

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `pi-anvil says: ${params.message}` }],
      details: { message: params.message },
    };
  },
});

export default function piAnvil(pi: ExtensionAPI) {
  pi.registerTool(anvilEchoTool);

  pi.registerCommand("anvil", {
    description: "Show that the pi-anvil extension is loaded.",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-anvil extension is loaded", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("pi-anvil extension loaded", "info");
  });
}
