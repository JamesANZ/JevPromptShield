import { analyze } from "../../analyze.js";
import { MAX_CONTENT_CHARS } from "../../config.js";
import { isShieldError, ShieldError } from "../../errors.js";
import { createLiveJevClient, type JevClient } from "../../jev/client.js";
import { resolveTypesafeApiKey } from "../../jev/key.js";
import type { MessagePart, Source } from "../../types.js";
import { claudeHookBody } from "./output.js";

const CONTENT_TIMEOUT_MS = 8_000;
const TEXT_CHUNK_SIZE = 90_000;
const CHUNK_OVERLAP = 1_000;

export interface ClaudeContentOptions {
  client?: JevClient;
  transcriber?: import("../../media/transcribe.js").MediaTranscriber;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeContentResult {
  exitCode: 0;
  body: Record<string, unknown>;
}

function textChunks(text: string): string[] {
  if (text.trim() === "") return [];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; ) {
    const end = Math.min(start + TEXT_CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

function mediaType(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function extractParts(value: unknown, includeMedia: boolean): MessagePart[] {
  const parts: MessagePart[] = [];
  const visited = new Set<object>();
  function walk(current: unknown, parentType?: string): void {
    if (typeof current === "string") {
      for (const chunk of textChunks(current))
        parts.push({ type: "text", content: chunk });
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach((item) => walk(item, parentType));
      return;
    }
    const object = current as Record<string, unknown>;
    const type = typeof object.type === "string" ? object.type : parentType;
    if (type === "text" && typeof object.text === "string") {
      walk(object.text, type);
      return;
    }
    if (includeMedia && type === "image" && typeof object.data === "string") {
      parts.push({
        type: "image",
        image: {
          media_type: mediaType(object.media_type ?? object.mimeType, "image/png"),
          data: object.data,
        },
      });
      return;
    }
    if (includeMedia && type === "audio" && typeof object.data === "string") {
      parts.push({
        type: "audio",
        audio: {
          media_type: mediaType(object.media_type ?? object.mimeType, "audio/mpeg"),
          data: object.data,
        },
      });
      return;
    }
    for (const [key, child] of Object.entries(object)) {
      if (key === "base64" || key === "image_url") continue;
      if ((key === "text" && type === "text") || key === "type") continue;
      walk(child, type);
    }
  }
  walk(value);
  return parts;
}

function sourceFor(toolName: string): Source {
  return toolName.startsWith("mcp__") ? "mcp" : "tool";
}

function eventBody(stdin: string, event: "PreToolUse" | "PostToolUse") {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch {
    throw new ShieldError("invalid_request", "Hook input was not valid JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShieldError("invalid_request", "Hook input must be an object.");
  }
  const body = raw as Record<string, unknown>;
  if (body.hook_event_name !== event || typeof body.tool_name !== "string") {
    throw new ShieldError("invalid_request", `Hook input is not ${event}.`);
  }
  return body;
}

async function scanParts(
  parts: MessagePart[],
  source: Source,
  options: ClaudeContentOptions,
) {
  if (parts.length > MAX_CONTENT_CHARS / TEXT_CHUNK_SIZE + 16) {
    throw new ShieldError("oversize", "Too many tool-content parts to scan safely.");
  }
  const apiKey = resolveTypesafeApiKey(options.env ?? process.env);
  if (!apiKey && !options.client) {
    throw new ShieldError(
      "jev_auth",
      "TYPESAFE_API_KEY is required to scan tool content.",
    );
  }
  const client =
    options.client ??
    createLiveJevClient({ apiKey, timeoutMs: CONTENT_TIMEOUT_MS });
  for (const part of parts) {
    const request =
      part.type === "text"
        ? { content: part.content, source }
        : part.type === "image"
          ? { image: part.image, source }
          : { audio: part.audio, source };
    const result = await analyze(request, {
      ...(options.client ? { client } : { client }),
      ...(options.transcriber ? { transcriber: options.transcriber } : {}),
    });
    if (!result.safe) {
      throw new ShieldError(
        "content_blocked",
        `Jev scored tool content as ${result.verdict} (${result.score.toFixed(2)}).`,
      );
    }
  }
}

function deny(reason: string): ClaudeContentResult {
  return { exitCode: 0, body: { ...claudeHookBody("BLOCK", reason) } };
}

export async function handleClaudeContentInput(
  stdin: string,
  options: ClaudeContentOptions = {},
): Promise<ClaudeContentResult> {
  try {
    const body = eventBody(stdin, "PreToolUse");
    if (body.tool_input === undefined) {
      throw new ShieldError("invalid_request", "tool_input is missing.");
    }
    const toolName = body.tool_name as string;
    const parts = extractParts(body.tool_input, false);
    await scanParts(parts, sourceFor(toolName), options);
    return { exitCode: 0, body: {} };
  } catch (error) {
    return deny(
      isShieldError(error)
        ? `${error.message} Tool call blocked.`
        : "Shield could not scan tool input. Tool call blocked.",
    );
  }
}

const PRESERVED_STRING_KEYS = new Set([
  "type",
  "media_type",
  "mimeType",
  "encoding",
  "format",
  "path",
  "filePath",
  "file_path",
]);

function quarantined(value: unknown): unknown {
  if (typeof value === "string")
    return "[JEV Shield quarantined potentially malicious tool output.]";
  if (Array.isArray(value)) return value.map(quarantined);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      typeof child === "string" && PRESERVED_STRING_KEYS.has(key)
        ? child
        : quarantined(child),
    ]),
  );
}

function blockedOutput(toolResponse: unknown, reason: string): ClaudeContentResult {
  return {
    exitCode: 0,
    body: {
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "JEV Shield replaced the original tool output because it could not be accepted as safe data.",
        updatedToolOutput: quarantined(toolResponse),
      },
    },
  };
}

export async function handleClaudeContentOutput(
  stdin: string,
  options: ClaudeContentOptions = {},
): Promise<ClaudeContentResult> {
  let toolResponse: unknown = "[Unavailable tool response]";
  try {
    const body = eventBody(stdin, "PostToolUse");
    if (body.tool_response === undefined) {
      throw new ShieldError("invalid_request", "tool_response is missing.");
    }
    toolResponse = body.tool_response;
    const toolName = body.tool_name as string;
    const parts = extractParts(toolResponse, true);
    await scanParts(parts, sourceFor(toolName), options);
    return { exitCode: 0, body: {} };
  } catch (error) {
    return blockedOutput(
      toolResponse,
      isShieldError(error)
        ? `${error.message} Original tool output quarantined.`
        : "Shield could not scan tool output. Original tool output quarantined.",
    );
  }
}
