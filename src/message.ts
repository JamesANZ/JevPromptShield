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
  Risk,
  Verdict,
} from "./types.js";

const SEVERITY: Record<Verdict, number> = {
  safe: 0,
  suspicious: 1,
  malicious: 2,
};

const RISK_SEVERITY: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

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

function validatePart(part: MessagePart, index: number): void {
  if (part === null || typeof part !== "object" || Array.isArray(part)) {
    throw new ShieldError(
      "invalid_request",
      `Message part ${index + 1} must be an object.`,
    );
  }
  if (part.type !== "text" && part.type !== "image" && part.type !== "audio") {
    throw new ShieldError(
      "invalid_request",
      `Message part ${index + 1} must have type text, image, or audio.`,
    );
  }
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
  request.parts.forEach(validatePart);

  const started = performance.now();
  const parts: AnalyzeMessageResult["parts"] = [];
  for (const [index, part] of request.parts.entries()) {
    const result = await analyze(requestForPart(part, request), options);
    parts.push({
      index,
      type: part.type,
      source: part.source ?? request.source ?? "unknown",
      result,
    });
  }

  const results = parts.map((part) => part.result);
  const highest = results.reduce((current, result) =>
    SEVERITY[result.verdict] > SEVERITY[current.verdict] ? result : current,
  );
  const risk = results.reduce<Risk>(
    (current, result) =>
      RISK_SEVERITY[result.risk] > RISK_SEVERITY[current] ? result.risk : current,
    "low",
  );
  const flagged = parts.filter((part) => !part.result.safe);
  const categories = [
    ...new Set<Category>(results.flatMap((result) => result.categories)),
  ];
  const models = [...new Set(results.map((result) => result.model))];
  const reason =
    flagged.length === 0
      ? "No attack signal crossed the suspicious threshold in any message part."
      : `Unsafe content detected in message part${flagged.length === 1 ? "" : "s"} ${flagged.map((part) => part.index + 1).join(", ")}.`;

  return {
    safe: flagged.length === 0,
    verdict: highest.verdict,
    risk,
    score: Math.max(...results.map((result) => result.score)),
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
