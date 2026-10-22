import { Type } from "@earendil-works/pi-ai";

export default function register(api: { Type: typeof Type; registerTool: (definition: any) => void }) {
  api.registerTool({
    name: "example_sandbox_exec",
    label: "Sandbox exec",
    description: "Exercise the restricted sandbox.exec facade.",
    parameters: api.Type.Object({ cmd: api.Type.String() }),
    async execute(_toolCallId: string, params: { cmd: string }, signal: AbortSignal | undefined, _onUpdate: unknown, context: { sandbox: { exec(input: { cmd: string }, signal?: AbortSignal): Promise<unknown> } }) {
      return context.sandbox.exec({ cmd: params.cmd }, signal);
    },
  });
}
