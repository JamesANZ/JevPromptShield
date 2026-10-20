import { ShieldError } from "../errors.js";
import { prepareMedia, type MediaKind } from "../media/transcribe.js";
import type { AnalyzeRequest, MediaAttachment, Thresholds } from "../types.js";
import { SOURCES, type Source } from "../types.js";

/** Text JSON stays at the original cap. Media JSON may be larger, up to the decoded media cap. */
const MAX_TEXT_BODY_BYTES = 1_000_000;
export const MAX_HTTP_BODY_BYTES = 16_000_000;

export function parseAnalyzeBody(raw: unknown, bytes?: number): AnalyzeRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShieldError(
      "invalid_request",
      "Request body must be a JSON object.",
    );
  }
  const body = raw as Record<string, unknown>;
  const hasContent = body.content !== undefined;
  const hasImage = body.image !== undefined;
  const hasAudio = body.audio !== undefined;
  const attachments = Number(hasContent) + Number(hasImage) + Number(hasAudio);
  if (attachments > 1) {
    throw new ShieldError(
      "invalid_request",
      "Pass content, image, or audio, not more than one.",
    );
  }
  if (
    !hasImage &&
    !hasAudio &&
    bytes !== undefined &&
    bytes > MAX_TEXT_BODY_BYTES
  ) {
    throw new ShieldError(
      "oversize",
      "Request body is too large. Shield does not truncate.",
    );
  }
  const request: AnalyzeRequest = {};
  if (hasContent) {
    if (typeof body.content !== "string") {
      throw new ShieldError("invalid_request", "content must be a string.");
    }
    request.content = body.content;
  } else if (hasImage) {
    request.image = parseAttachment("image", body.image);
  } else if (hasAudio) {
    request.audio = parseAttachment("audio", body.audio);
  } else {
    throw new ShieldError("invalid_request", "content must be a string.");
  }
  if (body.source !== undefined) {
    if (
      typeof body.source !== "string" ||
      !SOURCES.includes(body.source as Source)
    ) {
      throw new ShieldError(
        "invalid_request",
        `source must be one of: ${SOURCES.join(", ")}.`,
      );
    }
    request.source = body.source as Source;
  }
  if (body.context !== undefined) {
    if (typeof body.context !== "string") {
      throw new ShieldError("invalid_request", "context must be a string.");
    }
    request.context = body.context;
  }
  if (body.thresholds !== undefined) {
    request.thresholds = parseThresholds(body.thresholds);
  }
  return request;
}

function parseAttachment(kind: MediaKind, raw: unknown): MediaAttachment {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShieldError(
      "invalid_request",
      `${kind} must be an object with media_type and data.`,
    );
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.media_type !== "string") {
    throw new ShieldError(
      "invalid_request",
      `${kind}.media_type must be a string.`,
    );
  }
  if (typeof body.data !== "string") {
    throw new ShieldError(
      "invalid_request",
      `${kind}.data must be a base64 string.`,
    );
  }
  const prepared = prepareMedia(kind, {
    media_type: body.media_type,
    data: body.data,
  });
  return { media_type: prepared.mediaType, data: body.data };
}

function parseThresholds(raw: unknown): Partial<Thresholds> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShieldError("invalid_request", "thresholds must be an object.");
  }
  const body = raw as Record<string, unknown>;
  const thresholds: Partial<Thresholds> = {};
  for (const key of ["suspicious", "malicious"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "number") {
        throw new ShieldError(
          "invalid_request",
          `${key} threshold must be a number.`,
        );
      }
      thresholds[key] = body[key];
    }
  }
  return thresholds;
}

export async function readJsonBody(
  req: import("node:http").IncomingMessage,
): Promise<{ value: unknown; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.length;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      throw new ShieldError(
        "oversize",
        "Request body is too large. Shield does not truncate.",
      );
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    throw new ShieldError("invalid_request", "Request body is empty.");
  }
  try {
    return { value: JSON.parse(text) as unknown, bytes };
  } catch {
    throw new ShieldError("invalid_request", "Request body is not valid JSON.");
  }
}
