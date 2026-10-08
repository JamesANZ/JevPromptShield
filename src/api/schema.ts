import { ShieldError } from "../errors.js";
import type { AnalyzeRequest, Thresholds } from "../types.js";
import { SOURCES, type Source } from "../types.js";

const MAX_BODY_BYTES = 1_000_000;

export function parseAnalyzeBody(raw: unknown): AnalyzeRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShieldError(
      "invalid_request",
      "Request body must be a JSON object.",
    );
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.content !== "string") {
    throw new ShieldError("invalid_request", "content must be a string.");
  }
  const request: AnalyzeRequest = { content: body.content };
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
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
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
    return JSON.parse(text) as unknown;
  } catch {
    throw new ShieldError("invalid_request", "Request body is not valid JSON.");
  }
}
