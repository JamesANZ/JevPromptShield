import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { analyzeMessage } from "./message.js";
import { createLiveJevClient } from "./jev/client.js";
import { isShieldError, ShieldError } from "./errors.js";
import { readJsonBody } from "./api/schema.js";
import { MAX_CONTEXT_CHARS } from "./config.js";
import type { AnalyzeOptions } from "./analyze.js";
import type { MessagePart, Source } from "./types.js";

const DEFAULT_UPSTREAM = "https://api.openai.com/v1";
const DEFAULT_SCAN_TIMEOUT_MS = 20_000;

export interface OpenAiProxyOptions extends AnalyzeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  apiKey?: string;
  upstreamBaseUrl?: string;
  scanTimeoutMs?: number;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

interface ChatRequest {
  messages: ChatMessage[];
  [key: string]: unknown;
}

function scanTimeoutMs(options: OpenAiProxyOptions): number {
  if (options.scanTimeoutMs !== undefined) {
    if (
      !Number.isInteger(options.scanTimeoutMs) ||
      options.scanTimeoutMs < 1 ||
      options.scanTimeoutMs > 120_000
    ) {
      throw new ShieldError(
        "invalid_request",
        "scanTimeoutMs must be an integer from 1 to 120000.",
      );
    }
    return options.scanTimeoutMs;
  }
  const raw = options.env?.JEV_SHIELD_PROXY_SCAN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SCAN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new ShieldError(
      "invalid_request",
      "JEV_SHIELD_PROXY_SCAN_TIMEOUT_MS must be an integer from 1000 to 120000.",
    );
  }
  return parsed;
}

async function withDeadline<T>(timeoutMs: number, work: () => Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ShieldError(
              "jev_unavailable",
              `Content analysis exceeded ${timeoutMs}ms. The request was not sent upstream.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShieldError("invalid_request", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function dataImage(value: unknown): MessagePart {
  if (typeof value !== "string") {
    throw new ShieldError("invalid_request", "image_url must be a string.");
  }
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
  if (!match || !match[1] || !match[2]) {
    throw new ShieldError(
      "invalid_request",
      "Only inline base64 image data is accepted by the guarded proxy. Remote image URLs are not fetched.",
    );
  }
  return {
    type: "image",
    image: { media_type: match[1], data: match[2] },
  };
}

const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  webm: "audio/webm",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

function audioPart(value: unknown): MessagePart {
  const audio = object(value, "input_audio");
  if (typeof audio.data !== "string" || typeof audio.format !== "string") {
    throw new ShieldError(
      "invalid_request",
      "input_audio requires base64 data and a format.",
    );
  }
  const mediaType = AUDIO_TYPES[audio.format.toLowerCase()];
  if (!mediaType) {
    throw new ShieldError(
      "invalid_request",
      "Unsupported input_audio format.",
    );
  }
  return {
    type: "audio",
    audio: { media_type: mediaType, data: audio.data },
  };
}

function contentParts(content: unknown, label: string): MessagePart[] {
  if (typeof content === "string") {
    return content.trim() === "" ? [] : [{ type: "text", content }];
  }
  if (!Array.isArray(content)) {
    throw new ShieldError(
      "invalid_request",
      `${label} content must be a string or an array.`,
    );
  }
  return content.map((raw, index) => {
    const part = object(raw, `${label} part ${index + 1}`);
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      return { type: "text", content: part.text };
    }
    if (part.type === "image_url") {
      const image = object(part.image_url, "image_url");
      return dataImage(image.url);
    }
    if (part.type === "input_image") {
      return dataImage(part.image_url);
    }
    if (part.type === "input_audio") return audioPart(part.input_audio);
    throw new ShieldError(
      "invalid_request",
      `Unsupported ${label} content part at index ${index}.`,
    );
  });
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part === null || typeof part !== "object" || Array.isArray(part))
        return "";
      const value = part as Record<string, unknown>;
      return (value.type === "text" || value.type === "input_text") &&
        typeof value.text === "string"
        ? value.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function conversationContext(
  messages: ChatMessage[],
  currentIndex: number,
  configured?: string,
): string | undefined {
  if (configured !== undefined && configured.length > MAX_CONTEXT_CHARS) {
    throw new ShieldError(
      "invalid_request",
      `JEV_SHIELD_PROXY_CONTEXT exceeds ${MAX_CONTEXT_CHARS} characters.`,
    );
  }
  const chunks: string[] = [];
  let budget = MAX_CONTEXT_CHARS - (configured?.length ?? 0);
  for (let index = currentIndex - 1; index >= 0 && budget > 100; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = plainText(message.content).trim();
    if (text === "") continue;
    const chunk = `Earlier user message: ${text}`;
    if (chunk.length > budget) continue;
    chunks.unshift(chunk);
    budget -= chunk.length + 2;
  }
  const context = [configured?.trim(), ...chunks].filter(Boolean).join("\n\n");
  return context === "" ? undefined : context;
}

function parseChatRequest(raw: unknown): ChatRequest {
  const body = object(raw, "Request body") as ChatRequest;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ShieldError(
      "invalid_request",
      "messages must be a non-empty array.",
    );
  }
  body.messages.forEach((message, index) =>
    object(message, `messages[${index}]`),
  );
  return body;
}

export async function guardChatCompletion(
  raw: unknown,
  options: OpenAiProxyOptions = {},
): Promise<ChatRequest> {
  const body = parseChatRequest(raw);
  const timeoutMs = scanTimeoutMs(options);
  const client =
    options.client ?? createLiveJevClient({ timeoutMs: Math.min(timeoutMs, 10_000) });
  const configuredContext = options.env?.JEV_SHIELD_PROXY_CONTEXT;
  await withDeadline(timeoutMs, async () => {
    for (const [index, message] of body.messages.entries()) {
      if (message.role !== "user" && message.role !== "tool") continue;
      const source: Source = message.role === "user" ? "user" : "tool";
      const parts = contentParts(message.content, `messages[${index}]`);
      if (parts.length === 0) continue;
      const context = conversationContext(
        body.messages,
        index,
        configuredContext,
      );
      const result = await analyzeMessage(
        {
          parts,
          source,
          ...(context ? { context } : {}),
        },
        { ...options, client },
      );
      if (!result.safe) {
        throw new ShieldError(
          "content_blocked",
          `Shield blocked messages[${index}] as ${result.verdict} (${result.score.toFixed(2)}).`,
        );
      }
    }
  });
  return body;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (isShieldError(error)) {
    sendJson(res, error.status, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  sendJson(res, 502, {
    error: {
      code: "upstream_unavailable",
      message: "The upstream model request failed.",
    },
  });
}

export function createOpenAiProxyServer(options: OpenAiProxyOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const upstream = (
    options.upstreamBaseUrl ??
    env.OPENAI_BASE_URL ??
    DEFAULT_UPSTREAM
  ).replace(/\/$/, "");
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, guarded: "/v1/chat/completions" });
        return;
      }
      if (url.pathname !== "/v1/chat/completions") {
        sendJson(res, 404, {
          error: { code: "invalid_request", message: "Not found." },
        });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, {
          error: { code: "invalid_request", message: "Use POST." },
        });
        return;
      }
      const apiKey = options.apiKey ?? env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        throw new ShieldError(
          "jev_auth",
          "OPENAI_API_KEY is required by the guarded proxy.",
        );
      }
      const uploaded = await readJsonBody(req);
      const body = await guardChatCompletion(uploaded.value, {
        ...options,
        env,
      });
      const response = await fetchImpl(`${upstream}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      res.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      if (!response.body) {
        res.end();
        return;
      }
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else res.destroy(error instanceof Error ? error : undefined);
    }
  });
}
