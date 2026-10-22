import type { ChronoEvent } from "./ipc/types.ts";

export const ATTACHMENT_ONLY_PROMPT = "我上传了附件，请查看并回应。";

/** Tell the agent where inbound files landed inside the sandbox workspace. */
export function buildAttachmentNote(event: ChronoEvent): string {
  const attachments = event.message.attachments ?? [];
  if (attachments.length === 0) return "";
  const lines = attachments.map((attachment) => {
    const label = attachment.name
      ? `${attachment.mime}, ${attachment.name}`
      : attachment.mime;
    return attachment.local_path
      ? `- ${attachment.local_path} (${label})`
      : `- unavailable (${label})`;
  });
  return `[Attachments]\n${lines.join("\n")}\nUse sandbox tools with these /workspace paths.\n\n`;
}
