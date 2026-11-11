import { analyze, type AnalyzeOptions } from "./analyze.js";
import {
  MAX_MESSAGE_PARTS,
  POLICY_VERSION,
  QUESTION_SET_VERSION,
} from "./config.js";
import { ShieldError } from "./errors.js";
import type {
  AnalyzeMessageRequest,
  AnalyzeMessageResult,
  AnalyzeResult,
  Category,
  MessagePart,
  Source,
  Verdict,
} from "./types.js";
import { SOURCES } from "./types.js";

const SEVERITY: Record<Verdict, number> = {
  safe: 0,
  suspicious: 1,
  malicious: 2,
};

function requestForPart(
  part: MessagePart,
  request: AnalyzeMessageRequest,
): Parameters<typeof analyze>[0] {
  const source = part.source ?? request.source ?? "unknown";
  const common = {
    source,
    ...(request.context !== undefined ? { context: request.context } : {}),
    ...(request.thresholds !== undefined
      ? { thresholds: request.thresholds }
      : {}),
  };
  if (part.type === "text") return { ...common, content: part.content };
  if (part.type === "image") return { ...common, image: part.image };
  return { ...common, audio: part.audio };
}

function attachment(value: unknown, index: number, kind: "image" | "audio") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShieldError(
      "invalid_request",
      `Message part ${index + 1} ${kind} must be an object.`,
    );
  }
  return value as { media_type: string; data: string | Uint8Array };
}

/** The part tag and its payload are one state. A text tag cannot carry an image. */
function parsePart(part: unknown, index: number): MessagePart {
  if (part === null || typeof part !== "object" || Array.isArray(part)) {
    throw new ShieldError(
      "invalid_request",
      `Message part ${index + 1} must be an object.`,
    );
  }
  const body = part as Record<string, unknown>;
  let source: { source?: Source } = {};
  if (body.source !== undefined) {
    if (typeof body.source !== "string" || !SOURCES.includes(body.source as Source)) {
      throw new ShieldError(
        "invalid_request",
        `Message part ${index + 1} source must be one of: ${SOURCES.join(", ")}.`,
      );
    }
    source = { source: body.source as Source };
  }
  if (body.type === "text") {
    if (typeof body.content !== "string") {
      throw new ShieldError(
        "invalid_request",
        `Message part ${index + 1} content must be a string.`,
      );
    }
    return { ...source, type: "text", content: body.content };
  }
  if (body.type === "image") {
    return { ...source, type: "image", image: attachment(body.image, index, "image") };
  }
  if (body.type === "audio") {
    return { ...source, type: "audio", audio: attachment(body.audio, index, "audio") };
  }
  throw new ShieldError(
    "invalid_request",
    `Message part ${index + 1} must have type text, image, or audio.`,
  );
}

export async function analyzeMessage(
  request: AnalyzeMessageRequest,
  options?: AnalyzeOptions,
): Promise<AnalyzeMessageResult> {
  if (!Array.isArray(request.parts) || request.parts.length === 0) {
    throw new ShieldError(
      "invalid_request",
      "parts must contain at least one message part.",
    );
  }
  if (request.parts.length > MAX_MESSAGE_PARTS) {
    throw new ShieldError(
      "oversize",
      `A message can contain at most ${MAX_MESSAGE_PARTS} parts.`,
    );
  }
  const parsed = request.parts.map((part, index) => parsePart(part, index));

  const started = performance.now();
  const parts: AnalyzeMessageResult["parts"] = [];
  for (const [index, part] of parsed.entries()) {
    const result = await analyze(requestForPart(part, request), options);
    parts.push({
      index,
      type: part.type,
      source: part.source ?? request.source ?? "unknown",
      result,
    });
  }

  const results = parts.map((part) => part.result);
  const winner = results.reduce((current, result) => {
    const verdictRank = SEVERITY[result.verdict] - SEVERITY[current.verdict];
    if (verdictRank > 0 || (verdictRank === 0 && result.score > current.score)) {
      return result;
    }
    return current;
  });
  const flagged = parts.filter((part) => part.result.verdict !== "safe");
  const categories = [
    ...new Set<Category>(results.flatMap((result) => result.categories)),
  ];
  const models = [...new Set(results.map((result) => result.model))];
  const reason =
    flagged.length === 0
      ? "No attack signal crossed the suspicious threshold in any message part."
      : `Unsafe content detected in message part${flagged.length === 1 ? "" : "s"} ${flagged.map((part) => part.index + 1).join(", ")}.`;

  return {
    safe: winner.safe,
    verdict: winner.verdict,
    risk: winner.risk,
    score: winner.score,
    categories,
    reason,
    parts,
    model: models.length === 1 ? (models[0] ?? "unknown") : "mixed",
    usage: results.reduce(
      (usage, result) => ({
        input_tokens: usage.input_tokens + result.usage.input_tokens,
        output_tokens: usage.output_tokens + result.usage.output_tokens,
        estimated_cost_usd:
          usage.estimated_cost_usd + result.usage.estimated_cost_usd,
      }),
      { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
    ),
    latency_ms: performance.now() - started,
    policy_version: POLICY_VERSION,
    question_set_version: QUESTION_SET_VERSION,
  };
}
