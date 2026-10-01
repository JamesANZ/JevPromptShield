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

export const CONTENT_ROLES = ["data", "user_task", "model_instruction"] as const;

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

export interface AnalyzeRequest {
  content: string;
  source?: Source;
  context?: string;
  thresholds?: Partial<Thresholds>;
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
}
