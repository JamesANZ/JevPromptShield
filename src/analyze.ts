import {
  MAX_CONTENT_CHARS,
  MAX_CONTEXT_CHARS,
  resolveThresholds,
} from "./config.js";
import { ShieldError } from "./errors.js";
import { applyPolicy, type JevDecision } from "./engine/policy.js";
import { createLiveJevClient, type JevClient } from "./jev/client.js";
import type { AnalyzeRequest, AnalyzeResult, Source } from "./types.js";
import { SOURCES } from "./types.js";

export interface AnalyzeOptions {
  client?: JevClient;
}

export function normalizeRequest(request: AnalyzeRequest): {
  content: string;
  source: Source;
  context?: string;
} {
  if (typeof request.content !== "string" || request.content.trim() === "") {
    throw new ShieldError(
      "invalid_request",
      "content must be a non-empty string.",
    );
  }
  if (request.content.length > MAX_CONTENT_CHARS) {
    throw new ShieldError(
      "oversize",
      `content exceeds ${MAX_CONTENT_CHARS} characters, the conservative limit under Jev's token budget. Shield does not truncate.`,
    );
  }
  const source = request.source ?? "unknown";
  if (!SOURCES.includes(source)) {
    throw new ShieldError(
      "invalid_request",
      `source must be one of: ${SOURCES.join(", ")}.`,
    );
  }
  if (request.context !== undefined) {
    if (typeof request.context !== "string") {
      throw new ShieldError("invalid_request", "context must be a string.");
    }
    if (request.context.length > MAX_CONTEXT_CHARS) {
      throw new ShieldError(
        "invalid_request",
        `context exceeds ${MAX_CONTEXT_CHARS} characters.`,
      );
    }
  }
  const normalized: { content: string; source: Source; context?: string } = {
    content: request.content,
    source,
  };
  if (request.context !== undefined && request.context !== "") {
    normalized.context = request.context;
  }
  return normalized;
}

export function resultFromDecision(
  decision: JevDecision,
  thresholds: ReturnType<typeof resolveThresholds>,
  latencyMs: number,
): AnalyzeResult {
  return {
    ...applyPolicy(decision, thresholds),
    latency_ms: latencyMs,
  };
}

export async function analyze(
  request: AnalyzeRequest,
  options?: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const normalized = normalizeRequest(request);
  const thresholds = resolveThresholds(request.thresholds);
  const client = options?.client ?? createLiveJevClient();
  const started = performance.now();
  const decision = await client.decide(normalized);
  return resultFromDecision(decision, thresholds, performance.now() - started);
}

export const jevShield = {
  /**
   * Score one piece of text. `source` defaults to `unknown`, which is treated as untrusted data.
   * Pass the real source so a user task and a retrieved document are judged differently.
   */
  analyze(
    content: string,
    options?: Omit<AnalyzeRequest, "content"> & AnalyzeOptions,
  ): Promise<AnalyzeResult> {
    const { client, ...request } = options ?? {};
    return analyze({ content, ...request }, { client });
  },
};
