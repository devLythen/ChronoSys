import { Type } from "@earendil-works/pi-ai";

export default function register(api: { Type: typeof Type; registerTool: (definition: any) => void; registerCommand: (definition: any) => void }) {
  api.registerTool({
    name: "example.send",
    label: "Send through Chrono",
    description: "Exercise the restricted platform.send facade.",
    parameters: api.Type.Object({ text: api.Type.String() }),
    async execute(_toolCallId: string, params: { text: string }, signal: AbortSignal | undefined, _onUpdate: unknown, context: { platform: { send(input: { text: string }, signal?: AbortSignal): Promise<unknown> } }) {
      return context.platform.send({ text: params.text }, signal);
    },
  });
  api.registerCommand({
    name: "weather",
    label: "Weather",
    description: "Send a deterministic weather response.",
    async execute(_commandId: string, args: string, context: { platform: { send(input: { text: string }): Promise<unknown> } }) {
      await context.platform.send({ text: `Weather for ${args || "current location"}: clear.` });
    },
  });
}
