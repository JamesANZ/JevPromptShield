import {
  COMPARE_QUESTION_SET_VERSION,
  MAX_CONTENT_CHARS,
  MAX_DOCUMENTS,
  MAX_QUESTION_CHARS,
  MIN_DOCUMENTS,
  estimateJevCostUsd,
  resolveMatchThreshold,
} from "./config.js";
import { isShieldError, ShieldError } from "./errors.js";
import {
  createLiveDocumentJudge,
  type DocumentJudge,
} from "./jev/documents.js";
import {
  createOpenAiMediaTranscriber,
  prepareMedia,
  type MediaTranscriber,
} from "./media/transcribe.js";
import type {
  CompareDocument,
  CompareDocumentResult,
  CompareRequest,
  CompareResult,
} from "./types.js";

export interface CompareOptions {
  judge?: DocumentJudge;
  transcriber?: MediaTranscriber;
}

const DOCUMENT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

interface ResolvedDocument {
  id: string;
  name: string;
  content: string;
  transcript?: string;
}

function documentLabel(index: number, name?: string): string {
  return name && name.trim() !== "" ? name.trim() : `document ${index + 1}`;
}

async function documentText(
  document: CompareDocument,
  index: number,
  transcriber: MediaTranscriber,
): Promise<{ content: string; transcript?: string }> {
  const hasContent = document.content !== undefined;
  const hasImage = document.image !== undefined;
  const hasAudio = document.audio !== undefined;
  const attachments = Number(hasContent) + Number(hasImage) + Number(hasAudio);
  const label = documentLabel(index, document.name);
  if (attachments !== 1) {
    throw new ShieldError(
      "invalid_request",
      `${label} must include content, image, or audio, and only one of them.`,
    );
  }
  if (hasContent) {
    if (
      typeof document.content !== "string" ||
      document.content.trim() === ""
    ) {
      throw new ShieldError(
        "invalid_request",
        `${label} content must be a non-empty string.`,
      );
    }
    return { content: document.content };
  }
  const kind = hasImage ? "image" : "audio";
  const attachment = hasImage ? document.image : document.audio;
  if (!attachment) {
    throw new ShieldError(
      "invalid_request",
      `${label} is missing its attachment.`,
    );
  }
  const prepared = prepareMedia(kind, attachment);
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
        ? `No text could be read from ${label}.`
        : `No speech could be transcribed from ${label}.`,
    );
  }
  return { content: transcript, transcript };
}

function assignIds(documents: CompareDocument[]): string[] {
  const explicit = new Set<string>();
  for (const [index, document] of documents.entries()) {
    if (document.id === undefined) continue;
    if (typeof document.id !== "string" || !DOCUMENT_ID.test(document.id)) {
      throw new ShieldError(
        "invalid_request",
        `${documentLabel(index, document.name)} id must start with a letter and use only letters, numbers, underscores, and hyphens.`,
      );
    }
    if (explicit.has(document.id)) {
      throw new ShieldError(
        "invalid_request",
        `Document id ${document.id} is used more than once.`,
      );
    }
    explicit.add(document.id);
  }
  return documents.map((document, index) => {
    if (document.id !== undefined) return document.id;
    const generated = `document_${index + 1}`;
    if (explicit.has(generated)) {
      throw new ShieldError(
        "invalid_request",
        `Document id ${generated} is already used. Set an id on each document.`,
      );
    }
    explicit.add(generated);
    return generated;
  });
}

export async function compareDocuments(
  request: CompareRequest,
  options?: CompareOptions,
): Promise<CompareResult> {
  if (typeof request.question !== "string" || request.question.trim() === "") {
    throw new ShieldError(
      "invalid_request",
      "question must be a non-empty string.",
    );
  }
  if (request.question.length > MAX_QUESTION_CHARS) {
    throw new ShieldError(
      "invalid_request",
      `question exceeds ${MAX_QUESTION_CHARS} characters.`,
    );
  }
  if (!Array.isArray(request.documents)) {
    throw new ShieldError("invalid_request", "documents must be an array.");
  }
  if (
    request.documents.length < MIN_DOCUMENTS ||
    request.documents.length > MAX_DOCUMENTS
  ) {
    throw new ShieldError(
      "invalid_request",
      `Attach ${MIN_DOCUMENTS} to ${MAX_DOCUMENTS} documents.`,
    );
  }
  for (const document of request.documents) {
    if (
      document === null ||
      typeof document !== "object" ||
      Array.isArray(document)
    ) {
      throw new ShieldError(
        "invalid_request",
        "Each document must be an object.",
      );
    }
  }
  const threshold = resolveMatchThreshold(request.threshold);
  const transcriber = options?.transcriber ?? createOpenAiMediaTranscriber();
  const ids = assignIds(request.documents);
  const resolved: ResolvedDocument[] = [];
  for (const [index, document] of request.documents.entries()) {
    if (document.name !== undefined && typeof document.name !== "string") {
      throw new ShieldError(
        "invalid_request",
        "document name must be a string.",
      );
    }
    if (document.name !== undefined && document.name.length > 200) {
      throw new ShieldError(
        "invalid_request",
        "document name exceeds 200 characters.",
      );
    }
    const text = await documentText(document, index, transcriber);
    const id = ids[index] ?? `document_${index + 1}`;
    resolved.push({
      id,
      name: documentLabel(index, document.name ?? id),
      content: text.content,
      ...(text.transcript !== undefined ? { transcript: text.transcript } : {}),
    });
  }
  const combined =
    request.question.length +
    resolved.reduce((total, document) => total + document.content.length, 0);
  if (combined > MAX_CONTENT_CHARS) {
    throw new ShieldError(
      "oversize",
      `The question and documents together exceed ${MAX_CONTENT_CHARS} characters. Shield does not truncate.`,
    );
  }
  const judge = options?.judge ?? createLiveDocumentJudge();
  const started = performance.now();
  const judgement = await judge.judge({
    question: request.question,
    documents: resolved.map((document) => ({
      id: document.id,
      name: document.name,
      content: document.content,
    })),
  });
  if (judgement.scores.length !== resolved.length) {
    throw new ShieldError(
      "jev_error",
      "Jev returned a different number of document scores.",
    );
  }
  const documents: CompareDocumentResult[] = resolved.map((document, index) => {
    const score = judgement.scores[index];
    if (score === undefined || score < 0 || score > 1) {
      throw new ShieldError(
        "jev_error",
        `Jev returned an unusable answer for ${document.id}.`,
      );
    }
    const result: CompareDocumentResult = {
      id: document.id,
      name: document.name,
      score,
      matches: score >= threshold,
    };
    if (document.transcript !== undefined)
      result.transcript = document.transcript;
    return result;
  });
  const matches = documents
    .map((document, index) => ({ document, index }))
    .filter((item) => item.document.matches)
    .sort(
      (left, right) =>
        right.document.score - left.document.score || left.index - right.index,
    )
    .map((item) => item.document);

  return {
    question: request.question,
    threshold,
    documents,
    matches,
    model: judgement.model,
    usage: {
      input_tokens: judgement.input_tokens,
      output_tokens: judgement.output_tokens,
      estimated_cost_usd: estimateJevCostUsd(judgement.input_tokens),
    },
    latency_ms: performance.now() - started,
    question_set_version: COMPARE_QUESTION_SET_VERSION,
  };
}
