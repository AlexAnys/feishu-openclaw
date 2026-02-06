/**
 * Inbound media handling — download images, files, video, and audio
 * from Feishu messages so the AI agent can see them.
 *
 * Ported from the standalone bridge (bridge.mjs) to the plugin architecture.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type * as Lark from "@larksuiteoapi/node-sdk";

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_MAX_INBOUND_IMAGE_MB = 12;
const DEFAULT_MAX_INBOUND_FILE_MB = 40;
const DEFAULT_INBOUND_FILE_TTL_MIN = 60;
const DEFAULT_MAX_ATTACHMENTS = 4;

// ─── Types ─────────────────────────────────────────────────────

export type InboundMediaConfig = {
  maxInboundImageMb?: number;
  maxInboundFileMb?: number;
  inboundFileTtlMin?: number;
  maxAttachments?: number;
};

export type InboundAttachment = {
  type: "image" | "file";
  content: string; // base64 data URL for images, file:// path for files
  mimeType: string;
  fileName: string;
};

export type ParsedInbound = {
  text: string;
  attachments: InboundAttachment[];
};

// ─── Helpers ───────────────────────────────────────────────────

function toNodeReadableStream(maybeStream: unknown): Readable | null {
  if (!maybeStream) return null;
  if (typeof (maybeStream as Readable).pipe === "function") return maybeStream as Readable;
  if (
    typeof (maybeStream as ReadableStream).getReader === "function" &&
    typeof Readable.fromWeb === "function"
  ) {
    return Readable.fromWeb(maybeStream as import("node:stream/web").ReadableStream);
  }
  return null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Normalize Feishu "text" payloads.
 * Some clients send HTML-ish strings like <p>- 1</p><p>- 2</p>.
 */
export function normalizeFeishuText(raw: string): string {
  let t = String(raw ?? "");

  // Convert common HTML blocks to newlines
  t = t.replace(/<\s*br\s*\/?>/gi, "\n");
  t = t.replace(/<\s*\/p\s*>\s*<\s*p\s*>/gi, "\n");
  t = t.replace(/<\s*p\s*>/gi, "");
  t = t.replace(/<\s*\/p\s*>/gi, "");

  // Strip remaining tags
  t = t.replace(/<[^>]+>/g, "");

  t = decodeHtmlEntities(t);

  // Normalize newlines
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");

  // Fix Feishu list quirk: sometimes list marker and content are split into two lines.
  //   "-\n1" -> "- 1"     "•\nfoo" -> "• foo"
  t = t.replace(/(^|\n)([-*•])\n(?=\S)/g, "$1$2 ");
  t = t.replace(/(^|\n)(\d+[.|)])\n(?=\S)/g, "$1$2 ");

  return t.trim();
}

function truncate(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(truncated, ${s.length} chars)`;
}

function guessMimeByExt(p: string): string {
  const e = path.extname(p).toLowerCase().replace(/^\./, "");
  if (e === "png") return "image/png";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "mp4") return "video/mp4";
  if (e === "mov") return "video/quicktime";
  if (e === "mp3") return "audio/mpeg";
  if (e === "wav") return "audio/wav";
  if (e === "m4a") return "audio/mp4";
  if (e === "opus") return "audio/opus";
  return "application/octet-stream";
}

function scheduleCleanup(filePath: string, minutes: number): void {
  const ms = Math.max(1, minutes) * 60 * 1000;
  const t = setTimeout(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }, ms);
  if (typeof t.unref === "function") t.unref();
}

function cleanupTempFile(filePath: string): void {
  try {
    if (filePath && filePath.startsWith(os.tmpdir())) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

// ─── Post (rich text) extraction ───────────────────────────────

export function extractFromPostJson(postJson: Record<string, unknown>): {
  text: string;
  imageKeys: string[];
} {
  const lines: string[] = [];
  const imageKeys: string[] = [];

  const pushLine = (s: string) => {
    const v = String(s ?? "").trimEnd();
    if (v.trim()) lines.push(v);
  };

  const inline = (node: unknown): string => {
    if (!node) return "";
    if (Array.isArray(node)) return node.map(inline).join("");
    if (typeof node !== "object") return "";

    const n = node as Record<string, unknown>;
    const tag = n.tag;
    if (typeof tag === "string") {
      if (tag === "text") return String(n.text ?? "");
      if (tag === "a") return String(n.text ?? n.href ?? "");
      if (tag === "at") return n.user_name ? `@${n.user_name}` : "@";
      if (tag === "md") return String(n.text ?? "");
      if (tag === "img") {
        if (n.image_key) imageKeys.push(String(n.image_key));
        return "[图片]";
      }
      if (tag === "file") return "[文件]";
      if (tag === "media") return "[视频]";
      if (tag === "hr") return "\n";
      if (tag === "code_block") {
        const lang = String(n.language || "").trim();
        const code = String(n.text || "");
        return `\n\n\`\`\`${lang ? ` ${lang}` : ""}\n${code}\n\`\`\`\n\n`;
      }
    }

    // Fallback: traverse children
    let acc = "";
    for (const v of Object.values(n)) {
      if (v && (typeof v === "object" || Array.isArray(v))) acc += inline(v);
    }
    return acc;
  };

  if (postJson?.title) pushLine(normalizeFeishuText(String(postJson.title)));

  const content = postJson?.content;
  if (Array.isArray(content)) {
    for (const paragraph of content) {
      if (Array.isArray(paragraph)) {
        const joined = paragraph.map(inline).join("");
        const normalized = normalizeFeishuText(joined);
        if (normalized) pushLine(normalized);
      } else {
        const normalized = normalizeFeishuText(inline(paragraph));
        if (normalized) pushLine(normalized);
      }
    }
  } else if (content) {
    const normalized = normalizeFeishuText(inline(content));
    if (normalized) pushLine(normalized);
  }

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, imageKeys: [...new Set(imageKeys)] };
}

// ─── Feishu media download ─────────────────────────────────────

/**
 * Download an image from Feishu by message_id + image_key, return as data URL.
 */
export async function downloadFeishuImageAsDataUrl(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  imageKey: string,
  maxMb = DEFAULT_MAX_INBOUND_IMAGE_MB,
): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `feishu_recv_${Date.now()}_${Math.random().toString(16).slice(2)}.png`,
  );

  try {
    const response = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });

    const data = response as Record<string, unknown>;
    const payload = data && typeof data === "object" && "data" in data ? data.data : data;

    // Handle multiple SDK response formats
    if (payload && typeof (payload as { writeFile?: Function }).writeFile === "function") {
      await (payload as { writeFile: (p: string) => Promise<void> }).writeFile(tmp);
    } else if (
      payload &&
      typeof (payload as { getReadableStream?: Function }).getReadableStream === "function"
    ) {
      const rs = (payload as { getReadableStream: () => unknown }).getReadableStream();
      const nodeRs = toNodeReadableStream(rs);
      if (!nodeRs) throw new Error("getReadableStream() returned non-stream");
      const out = fs.createWriteStream(tmp);
      await pipeline(nodeRs, out);
    } else if (payload && typeof (payload as Readable).pipe === "function") {
      const out = fs.createWriteStream(tmp);
      await pipeline(payload as Readable, out);
    } else if (
      data?.data &&
      typeof data.data === "object" &&
      typeof (data.data as Readable).pipe === "function"
    ) {
      const out = fs.createWriteStream(tmp);
      await pipeline(data.data as Readable, out);
    } else if (Buffer.isBuffer(payload)) {
      fs.writeFileSync(tmp, payload);
    } else if (payload instanceof ArrayBuffer) {
      fs.writeFileSync(tmp, Buffer.from(payload));
    } else if (ArrayBuffer.isView(payload)) {
      fs.writeFileSync(tmp, Buffer.from((payload as ArrayBufferView).buffer as ArrayBuffer));
    } else {
      const k = data && typeof data === "object" ? Object.keys(data).join(",") : "";
      throw new Error(`Unexpected response type: ${typeof data}${k ? ` (keys: ${k})` : ""}`);
    }

    // Size guard
    const st = fs.statSync(tmp);
    const maxBytes = maxMb * 1024 * 1024;
    if (st.size > maxBytes) {
      throw new Error(`Image too large (${st.size} bytes > ${maxBytes})`);
    }

    // Convert to base64 data URL
    const buf = fs.readFileSync(tmp);
    const b64 = buf.toString("base64");
    return `data:image/png;base64,${b64}`;
  } finally {
    cleanupTempFile(tmp);
  }
}

/**
 * Download a file/video/audio from Feishu by message_id + file_key.
 * Returns the local temp path; the caller should pass file:// to the agent.
 */
export async function downloadFeishuFileToPath(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  fileKey: string,
  fileName = "file.bin",
  type = "file",
  config?: InboundMediaConfig,
): Promise<string> {
  const maxMb = config?.maxInboundFileMb ?? DEFAULT_MAX_INBOUND_FILE_MB;
  const ttlMin = config?.inboundFileTtlMin ?? DEFAULT_INBOUND_FILE_TTL_MIN;

  const ext = path.extname(fileName || "") || ".bin";
  const tmp = path.join(
    os.tmpdir(),
    `feishu_recv_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`,
  );

  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  const data = response as Record<string, unknown>;
  const payload = data && typeof data === "object" && "data" in data ? data.data : data;

  if (payload && typeof (payload as { writeFile?: Function }).writeFile === "function") {
    await (payload as { writeFile: (p: string) => Promise<void> }).writeFile(tmp);
  } else if (
    payload &&
    typeof (payload as { getReadableStream?: Function }).getReadableStream === "function"
  ) {
    const rs = (payload as { getReadableStream: () => unknown }).getReadableStream();
    const nodeRs = toNodeReadableStream(rs);
    if (!nodeRs) throw new Error("getReadableStream() returned non-stream");
    const out = fs.createWriteStream(tmp);
    await pipeline(nodeRs, out);
  } else if (payload && typeof (payload as Readable).pipe === "function") {
    const out = fs.createWriteStream(tmp);
    await pipeline(payload as Readable, out);
  } else if (
    data?.data &&
    typeof data.data === "object" &&
    typeof (data.data as Readable).pipe === "function"
  ) {
    const out = fs.createWriteStream(tmp);
    await pipeline(data.data as Readable, out);
  } else if (Buffer.isBuffer(payload)) {
    fs.writeFileSync(tmp, payload);
  } else if (payload instanceof ArrayBuffer) {
    fs.writeFileSync(tmp, Buffer.from(payload));
  } else if (ArrayBuffer.isView(payload)) {
    fs.writeFileSync(tmp, Buffer.from((payload as ArrayBufferView).buffer as ArrayBuffer));
  } else {
    const k = data && typeof data === "object" ? Object.keys(data).join(",") : "";
    throw new Error(`Unexpected file response: ${typeof data}${k ? ` (keys: ${k})` : ""}`);
  }

  // Size guard
  const st = fs.statSync(tmp);
  const maxBytes = maxMb * 1024 * 1024;
  if (st.size > maxBytes) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new Error(`File too large (${st.size} bytes > ${maxBytes})`);
  }

  // Auto-cleanup after TTL
  scheduleCleanup(tmp, ttlMin);

  return tmp;
}

// ─── Main inbound parser ───────────────────────────────────────

/**
 * Parse a Feishu message into text + attachments for the AI agent.
 * Supports: text, post (rich text), image, media (video), file, audio.
 */
export async function buildInboundFromFeishuMessage(
  client: InstanceType<typeof Lark.Client>,
  message: Record<string, unknown>,
  config?: InboundMediaConfig,
  log?: { error: (msg: string) => void },
): Promise<ParsedInbound> {
  const messageId = message?.message_id as string | undefined;
  const messageType = message?.message_type as string | undefined;
  const rawContent = message?.content as string | undefined;
  const maxAttachments = config?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const maxImageMb = config?.maxInboundImageMb ?? DEFAULT_MAX_INBOUND_IMAGE_MB;

  const out: ParsedInbound = { text: "", attachments: [] };

  const fallback = `[Feishu消息] id=${messageId || "-"} type=${messageType}\ncontent=${truncate(rawContent || "", 1200)}`;

  if (!messageType || !rawContent) {
    out.text = fallback;
    return out;
  }

  // 1) text
  if (messageType === "text") {
    try {
      const parsed = JSON.parse(rawContent) as { text?: string };
      out.text = normalizeFeishuText(parsed?.text ?? "");
    } catch {
      out.text = "";
    }
  }

  // 2) post (rich text)
  if (messageType === "post") {
    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      const { text, imageKeys } = extractFromPostJson(parsed);
      out.text = text;

      // Download embedded images (best-effort)
      if (messageId && imageKeys.length > 0) {
        for (const k of imageKeys.slice(0, maxAttachments)) {
          try {
            const dataUrl = await downloadFeishuImageAsDataUrl(client, messageId, k, maxImageMb);
            out.attachments.push({
              type: "image",
              content: dataUrl,
              mimeType: "image/png",
              fileName: "feishu.png",
            });
          } catch (e) {
            log?.error(
              `post image download failed: messageId=${messageId} imageKey=${k} err=${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    } catch (e) {
      out.text = "";
      log?.error(`post parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3) image
  if (messageType === "image") {
    try {
      const parsed = JSON.parse(rawContent) as { image_key?: string };
      const imageKey = parsed?.image_key;
      if (imageKey && messageId) {
        const dataUrl = await downloadFeishuImageAsDataUrl(client, messageId, imageKey, maxImageMb);
        out.attachments.push({
          type: "image",
          content: dataUrl,
          mimeType: "image/png",
          fileName: "feishu.png",
        });
        out.text = "[图片]";
      }
    } catch (e) {
      out.text = "[图片]";
      log?.error(
        `image download failed: messageId=${messageId} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 4) media (video)
  if (messageType === "media") {
    try {
      const parsed = JSON.parse(rawContent) as {
        file_key?: string;
        file_name?: string;
        duration?: number;
        image_key?: string;
      };
      const fileKey = parsed?.file_key;
      const fileName = parsed?.file_name || "video.bin";
      const duration = parsed?.duration;
      const thumbKey = parsed?.image_key;

      out.text = `[视频] ${fileName}${duration ? ` (${duration}ms)` : ""}`;

      // Best-effort: thumbnail
      if (thumbKey && messageId && out.attachments.length < maxAttachments) {
        try {
          const thumbUrl = await downloadFeishuImageAsDataUrl(
            client,
            messageId,
            thumbKey,
            maxImageMb,
          );
          out.attachments.push({
            type: "image",
            content: thumbUrl,
            mimeType: "image/png",
            fileName: "feishu-thumb.png",
          });
        } catch (e) {
          log?.error(
            `media thumbnail failed: messageId=${messageId} imageKey=${thumbKey} err=${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Best-effort: download the video file
      if (fileKey && messageId) {
        try {
          const fp = await downloadFeishuFileToPath(
            client,
            messageId,
            fileKey,
            fileName,
            "file",
            config,
          );
          out.text += `\n\n[附件路径] file://${fp}`;
        } catch (e) {
          log?.error(
            `media download failed: messageId=${messageId} fileKey=${fileKey} err=${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      out.text = out.text || "[视频]";
      log?.error(`media parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5) file
  if (messageType === "file") {
    try {
      const parsed = JSON.parse(rawContent) as { file_key?: string; file_name?: string };
      const fileKey = parsed?.file_key;
      const fileName = parsed?.file_name || "file.bin";
      out.text = `[文件] ${fileName}`;

      if (fileKey && messageId) {
        try {
          const fp = await downloadFeishuFileToPath(
            client,
            messageId,
            fileKey,
            fileName,
            "file",
            config,
          );
          out.text += `\n\n[附件路径] file://${fp}`;
        } catch (e) {
          log?.error(
            `file download failed: messageId=${messageId} fileKey=${fileKey} err=${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      out.text = out.text || "[文件]";
      log?.error(`file parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 6) audio
  if (messageType === "audio") {
    try {
      const parsed = JSON.parse(rawContent) as { file_key?: string; file_name?: string };
      const fileKey = parsed?.file_key;
      const fileName = parsed?.file_name || "audio.opus";
      out.text = `[语音] ${fileName}`;

      if (fileKey && messageId) {
        try {
          const fp = await downloadFeishuFileToPath(
            client,
            messageId,
            fileKey,
            fileName,
            "file",
            config,
          );
          out.text += `\n\n[附件路径] file://${fp}`;
        } catch (e) {
          log?.error(
            `audio download failed: messageId=${messageId} fileKey=${fileKey} err=${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      out.text = out.text || "[语音]";
      log?.error(`audio parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Ensure we never silently drop: if still empty, use fallback.
  if (!out.text && out.attachments.length > 0) out.text = "[附件]";
  if (!out.text) out.text = fallback;

  // Hard cap
  if (out.attachments.length > maxAttachments) {
    out.attachments = out.attachments.slice(0, maxAttachments);
  }

  return out;
}
