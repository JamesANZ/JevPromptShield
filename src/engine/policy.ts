import { POLICY_VERSION, estimateJevCostUsd } from "../config.js";
import { ShieldError } from "../errors.js";
import { QUESTION_SET_VERSION } from "../engine/questions.js";
import type { AnalyzeResult, Category, ContentRole, Risk, Signal, Thresholds, Verdict } from "../types.js";
import { CATEGORIES, CONTENT_ROLES } from "../types.js";

export { POLICY_VERSION };

/** Extra diagnostic question. It does not set the verdict. */
export const SOURCE_BLIND_SIGNAL = "prompt_injection_source_blind";

export interface JevDecision {
  model: string;
  input_tokens: number;
  output_tokens: number;
  scores: Record<Category | typeof SOURCE_BLIND_SIGNAL, number>;
  content_role: ContentRole;
  content_role_probability: number;
}

const REASONS: Record<Category, string> = {
  prompt_injection: "manipulate the consuming model with an injected instruction",
  instruction_override: "override trusted instructions",
  system_prompt_extraction: "extract the system prompt",
  secret_extraction: "extract credentials or secrets",
  data_exfiltration: "disclose private information",
  malicious_tool_use: "invoke tools outside the original task",
  role_impersonation: "impersonate a privileged role",
  obfuscated_instruction: "hide instructions through encoding or obfuscation",
  embedded_instruction: "embed model-directed instructions inside otherwise ordinary content",
};

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function buildReason(verdict: Verdict, categories: Category[]): string {
  if (verdict === "safe") return "No attack signal crossed the suspicious threshold.";
  const phrases = categories.map((category) => REASONS[category]);
  if (phrases.length === 0) return "The primary prompt-injection score crossed the threshold.";
  return `Content attempts to ${joinAnd(phrases)}.`;
}

function assertScore(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ShieldError("jev_error", `Jev returned an unusable score for ${name}.`);
  }
}

export function applyPolicy(decision: JevDecision, thresholds: Thresholds): Omit<AnalyzeResult, "latency_ms"> {
  if (!CONTENT_ROLES.includes(decision.content_role)) {
    throw new ShieldError("jev_error", "Jev returned an unknown content role.");
  }
  assertScore("content_role", decision.content_role_probability);
  for (const category of CATEGORIES) {
    assertScore(category, decision.scores[category]);
  }
  assertScore(SOURCE_BLIND_SIGNAL, decision.scores[SOURCE_BLIND_SIGNAL]);

  const score = decision.scores.prompt_injection;
  let verdict: Verdict;
  let risk: Risk;
  if (score >= thresholds.malicious) {
    verdict = "malicious";
    risk = "high";
  } else if (score >= thresholds.suspicious) {
    verdict = "suspicious";
    risk = "medium";
  } else {
    verdict = "safe";
    risk = "low";
  }

  const signals: Record<string, Signal> = {};
  for (const category of CATEGORIES) {
    const categoryScore = decision.scores[category];
    signals[category] = {
      score: categoryScore,
      triggered: categoryScore >= thresholds.suspicious,
    };
  }
  const blind = decision.scores[SOURCE_BLIND_SIGNAL];
  signals[SOURCE_BLIND_SIGNAL] = {
    score: blind,
    triggered: blind >= thresholds.suspicious,
  };
  signals.content_role = {
    score: decision.content_role_probability,
    triggered:
      decision.content_role === "model_instruction" &&
      decision.content_role_probability >= thresholds.suspicious,
  };

  const categories =
    verdict === "safe" ? [] : CATEGORIES.filter((category) => signals[category]?.triggered === true);

  return {
    safe: verdict === "safe",
    verdict,
    risk,
    score,
    categories: [...categories],
    reason: buildReason(verdict, categories),
    signals,
    content_role: decision.content_role,
    model: decision.model,
    usage: {
      input_tokens: decision.input_tokens,
      output_tokens: decision.output_tokens,
      estimated_cost_usd: estimateJevCostUsd(decision.input_tokens),
    },
    policy_version: POLICY_VERSION,
    question_set_version: QUESTION_SET_VERSION,
  };
}
