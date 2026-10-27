export const SOURCES = [
  "user",
  "webpage",
  "pdf",
  "email",
  "rag",
  "tool",
  "mcp",
  "agent",
  "database",
  "unknown",
] as const;

export type Source = (typeof SOURCES)[number];

export const VERDICTS = ["safe", "suspicious", "malicious"] as const;

export type Verdict = (typeof VERDICTS)[number];

export const RISKS = ["low", "medium", "high"] as const;

export type Risk = (typeof RISKS)[number];

export const CONTENT_ROLES = [
  "data",
  "user_task",
  "model_instruction",
] as const;

export type ContentRole = (typeof CONTENT_ROLES)[number];

/** Attack signals. `prompt_injection` is also the primary score. */
export const CATEGORIES = [
  "prompt_injection",
  "instruction_override",
  "system_prompt_extraction",
  "secret_extraction",
  "data_exfiltration",
  "malicious_tool_use",
  "role_impersonation",
  "obfuscated_instruction",
  "embedded_instruction",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface Thresholds {
  suspicious: number;
  malicious: number;
}

/** Image or audio bytes. `data` is raw bytes in-process, or standard base64 on the HTTP API. */
export interface MediaAttachment {
  media_type: string;
  data: string | Uint8Array;
}

export interface AnalyzeRequest {
  content?: string;
  image?: MediaAttachment;
  audio?: MediaAttachment;
  source?: Source;
  context?: string;
  thresholds?: Partial<Thresholds>;
}

export type MessagePart = { source?: Source } & (
  | { type: "text"; content: string }
  | { type: "image"; image: MediaAttachment }
  | { type: "audio"; audio: MediaAttachment }
);

export interface AnalyzeMessageRequest {
  parts: MessagePart[];
  source?: Source;
  context?: string;
  thresholds?: Partial<Thresholds>;
}

export interface AnalyzeMessagePartResult {
  index: number;
  type: MessagePart["type"];
  source: Source;
  result: AnalyzeResult;
}

export interface AnalyzeMessageResult {
  safe: boolean;
  verdict: Verdict;
  risk: Risk;
  score: number;
  categories: Category[];
  reason: string;
  parts: AnalyzeMessagePartResult[];
  model: string;
  usage: Usage;
  latency_ms: number;
  policy_version: string;
  question_set_version: string;
}

/** One attachment in a comparison. Exactly one of content, image, or audio. */
export interface CompareDocument {
  id?: string;
  name?: string;
  content?: string;
  image?: MediaAttachment;
  audio?: MediaAttachment;
}

export interface CompareRequest {
  question: string;
  documents: CompareDocument[];
  threshold?: number;
}

export interface CompareDocumentResult {
  id: string;
  name: string;
  score: number;
  matches: boolean;
  /**
   * Text read from an image or audio attachment before the comparison.
   * Omitted for ordinary text documents.
   */
  transcript?: string;
}

export interface CompareResult {
  question: string;
  threshold: number;
  /** Documents in the order they were attached. */
  documents: CompareDocumentResult[];
  /** Documents at or above the match threshold, highest score first. */
  matches: CompareDocumentResult[];
  model: string;
  usage: Usage;
  latency_ms: number;
  question_set_version: string;
}

export interface Signal {
  score: number;
  triggered: boolean;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

export interface AnalyzeResult {
  safe: boolean;
  verdict: Verdict;
  risk: Risk;
  score: number;
  categories: Category[];
  reason: string;
  signals: Record<string, Signal>;
  content_role: ContentRole;
  model: string;
  usage: Usage;
  latency_ms: number;
  policy_version: string;
  question_set_version: string;
  /**
   * Text read from an image or audio attachment and then scored.
   * Omitted for ordinary text requests.
   */
  transcript?: string;
  /** Applied when a normalized or decoded form produced the selected verdict. */
  matched_transformation?: string;
  /** Labels only; decoded content is never copied into this diagnostic field. */
  examined_transformations?: string[];
}
