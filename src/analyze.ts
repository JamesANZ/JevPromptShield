import {
  MAX_CONTENT_CHARS,
  MAX_CONTEXT_CHARS,
  resolveThresholds,
} from "./config.js";
import { isShieldError, ShieldError } from "./errors.js";
import { applyPolicy, type JevDecision } from "./engine/policy.js";
import { createLiveJevClient, type JevClient } from "./jev/client.js";
import {
  createOpenAiMediaTranscriber,
  prepareMedia,
  type MediaTranscriber,
} from "./media/transcribe.js";
import type { AnalyzeRequest, AnalyzeResult, Source } from "./types.js";
import { SOURCES } from "./types.js";

export interface AnalyzeOptions {
  client?: JevClient;
  transcriber?: MediaTranscriber;
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

async function submittedContent(
  request: AnalyzeRequest,
  options?: AnalyzeOptions,
): Promise<{ content: string; transcript?: string }> {
  const hasImage = request.image !== undefined;
  const hasAudio = request.audio !== undefined;
  const hasContent = request.content !== undefined;
  if (Number(hasImage) + Number(hasAudio) + Number(hasContent) > 1) {
    throw new ShieldError(
      "invalid_request",
      "Pass content, image, or audio, not more than one.",
    );
  }
  if (!hasImage && !hasAudio) return { content: request.content ?? "" };

  const kind = hasImage ? "image" : "audio";
  const attachment = hasImage ? request.image : request.audio;
  if (!attachment) return { content: request.content ?? "" };
  const prepared = prepareMedia(kind, attachment);
  const transcriber = options?.transcriber ?? createOpenAiMediaTranscriber();
  let raw: string;
  try {
    raw =
      kind === "image"
        ? await transcriber.transcribeImage(prepared)
        : await transcriber.transcribeAudio(prepared);
  } catch (error) {
    if (isShieldError(error)) throw error;
    throw new ShieldError(
      "transcription_error",
      error instanceof Error ? error.message : "Transcription failed.",
      { cause: error },
    );
  }
  const transcript = raw.trim();
  if (transcript === "") {
    throw new ShieldError(
      "invalid_request",
      kind === "image"
        ? "No text could be read from the image."
        : "No speech could be transcribed from the audio.",
    );
  }
  return { content: transcript, transcript };
}

export async function analyze(
  request: AnalyzeRequest,
  options?: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const submitted = await submittedContent(request, options);
  const normalized = normalizeRequest({
    ...request,
    content: submitted.content,
  });
  const thresholds = resolveThresholds(request.thresholds);
  const client = options?.client ?? createLiveJevClient();
  const started = performance.now();
  const decision = await client.decide(normalized);
  const result = resultFromDecision(
    decision,
    thresholds,
    performance.now() - started,
  );
  if (submitted.transcript === undefined) return result;
  return { ...result, transcript: submitted.transcript };
}

export const jevShield = {
  /**
   * Score one piece of text. `source` defaults to `unknown`, which is treated as untrusted data.
   * Pass the real source so a user task and a retrieved document are judged differently.
   */
  analyze(
    content: string,
    options?: Omit<AnalyzeRequest, "content" | "image" | "audio"> &
      AnalyzeOptions,
  ): Promise<AnalyzeResult> {
    const { client, transcriber, ...request } = options ?? {};
    return analyze({ content, ...request }, { client, transcriber });
  },

  /**
   * Read visible writing from an image, then score that text with the same decision path as `analyze`.
   */
  analyzeImage(
    image: AnalyzeRequest["image"],
    options?: Omit<AnalyzeRequest, "content" | "image" | "audio"> &
      AnalyzeOptions,
  ): Promise<AnalyzeResult> {
    const { client, transcriber, ...request } = options ?? {};
    return analyze({ ...request, image }, { client, transcriber });
  },

  /**
   * Transcribe speech, then score that transcript with the same decision path as `analyze`.
   */
  analyzeAudio(
    audio: AnalyzeRequest["audio"],
    options?: Omit<AnalyzeRequest, "content" | "image" | "audio"> &
      AnalyzeOptions,
  ): Promise<AnalyzeResult> {
    const { client, transcriber, ...request } = options ?? {};
    return analyze({ ...request, audio }, { client, transcriber });
  },
};
