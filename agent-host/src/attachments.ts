import type { ImageContent } from "@earendil-works/pi-ai";
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

/** Resolve an image MIME type from the declared type or the file extension. */
function imageMime(attachment: ChronoEvent["message"]["attachments"][number]): string | undefined {
  const mime = attachment.mime.toLowerCase();
  if (mime === "image/png") return "image/png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "image/jpeg";
  if (mime === "image/webp") return "image/webp";
  if (mime === "image/gif") return "image/gif";
  const name = (attachment.name ?? "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return undefined;
}

/** Convert inline image attachments into Pi native multimodal input. */
export function inlineImages(
  event: ChronoEvent,
  supportsImage: boolean,
): ImageContent[] {
  if (!supportsImage) return [];
  return (event.message.attachments ?? []).flatMap((attachment) => {
    const mimeType = imageMime(attachment);
    if (!attachment.inline_data || !mimeType) return [];
    return [{ type: "image" as const, data: attachment.inline_data, mimeType }];
  });
}
