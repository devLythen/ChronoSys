import { Type } from "@earendil-works/pi-ai";

export default function register(api: { Type: typeof Type; registerTool: (definition: any) => void }) {
  api.registerTool({
    name: "example_echo",
    label: "Echo",
    description: "Return deterministic fixture text.",
    parameters: api.Type.Object({ text: api.Type.String() }),
    async execute(_toolCallId: string, params: { text: string }) {
      const text = `echo:${params.text}`;
      return { content: [{ type: "text", text }], details: { text } };
    },
  });
}
