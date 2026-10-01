import { JEV_INPUT_USD_PER_MILLION, POLICY_VERSION, QUESTION_SET_VERSION, resolveThresholds } from "../config.js";
import { CATEGORIES } from "../types.js";
import { resultFromDecision } from "../analyze.js";
import { analyze } from "../analyze.js";
import type { JevDecision } from "../engine/policy.js";
import { SOURCE_BLIND_SIGNAL } from "../engine/policy.js";
import type { JevClient } from "../jev/client.js";
import type { CorpusCase } from "./corpus.js";
import { CORPUS_TAGS } from "./corpus.js";
import { buildEvalReport, type EvalReport, type ScoredCase } from "./metrics.js";
import { splitForId } from "./split.js";

export function selectSplit(cases: CorpusCase[], split: "dev" | "test" | "all"): CorpusCase[] {
  if (split === "all") return cases;
  return cases.filter((item) => splitForId(item.id) === split);
}

export async function scoreCorpus(input: {
  cases: CorpusCase[];
  client?: JevClient;
  fixtures?: Map<string, JevDecision>;
  thresholds?: { suspicious: number; malicious: number };
}): Promise<{ rows: ScoredCase[]; errors: string[] }> {
  const thresholds = input.thresholds ?? resolveThresholds();
  const rows: ScoredCase[] = [];
  const errors: string[] = [];
  for (const item of input.cases) {
    try {
      const request = {
        content: item.content,
        source: item.source,
        ...(item.context ? { context: item.context } : {}),
        thresholds,
      };
      let result;
      let latency: number | null;
      let tokens: number | null;
      if (input.fixtures) {
        const decision = input.fixtures.get(item.id);
        if (!decision) throw new Error(`missing fixture for ${item.id}`);
        result = resultFromDecision(decision, thresholds, 0);
        latency = null;
        tokens = null;
      } else if (input.client) {
        result = await analyze(request, { client: input.client });
        latency = result.latency_ms;
        tokens = result.usage.input_tokens;
      } else {
        throw new Error("scoreCorpus needs a client or fixtures.");
      }
      const triggered = CATEGORIES.filter((category) => result.signals[category]?.triggered === true);
      const blind = result.signals[SOURCE_BLIND_SIGNAL]?.score;
      rows.push({
        id: item.id,
        tags: item.tags,
        expectedVerdict: item.expected.verdict,
        expectedCategories: item.expected.categories,
        predictedVerdict: result.verdict,
        score: result.score,
        sourceBlindScore: typeof blind === "number" ? blind : 0,
        categoryUnionHit: triggered.length > 0,
        triggeredCategories: triggered,
        latencyMs: latency,
        inputTokens: tokens,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      errors.push(`${item.id}: ${message}`);
    }
  }
  return { rows, errors };
}

export async function evaluateCorpus(input: {
  cases: CorpusCase[];
  mode: "live" | "fixture";
  split: "dev" | "test" | "all";
  client?: JevClient;
  fixtures?: Map<string, JevDecision>;
  thresholds?: { suspicious: number; malicious: number };
}): Promise<EvalReport> {
  const selected = selectSplit(input.cases, input.split);
  const thresholds = input.thresholds ?? resolveThresholds();
  const scored = await scoreCorpus({
    cases: selected,
    thresholds,
    ...(input.client ? { client: input.client } : {}),
    ...(input.fixtures ? { fixtures: input.fixtures } : {}),
  });
  return buildEvalReport({
    mode: input.mode,
    rows: scored.rows,
    errors: scored.errors,
    split: input.split,
    thresholds,
    questionSetVersion: QUESTION_SET_VERSION,
    policyVersion: POLICY_VERSION,
    inputUsdPerMillion: JEV_INPUT_USD_PER_MILLION,
    tags: [...CORPUS_TAGS],
  });
}

export function formatRate(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatReport(report: EvalReport): string {
  const lines = [
    `JEV Shield eval (${report.mode}, split ${report.split}, n=${report.n}, errors=${report.errors.length})`,
    `question_set ${report.question_set_version}  policy ${report.policy_version}`,
    `thresholds suspicious=${report.thresholds.suspicious} malicious=${report.thresholds.malicious}`,
    `detection recall ${formatRate(report.binary.recall)}  precision ${formatRate(report.binary.precision)}  f1 ${formatRate(report.binary.f1)}`,
    `false positive ${formatRate(report.binary.false_positive_rate)}  false negative ${formatRate(report.binary.false_negative_rate)}`,
    `strict malicious recall ${formatRate(report.strict_malicious.recall)}  fpr ${formatRate(report.strict_malicious.false_positive_rate)}`,
    `source-blind recall ${formatRate(report.source_blind.recall)}  fpr ${formatRate(report.source_blind.false_positive_rate)}`,
    `category-union recall ${formatRate(report.category_union.recall)}  fpr ${formatRate(report.category_union.false_positive_rate)}`,
    `expected category recall ${formatRate(report.expected_category_recall)}`,
  ];
  if (report.latency_ms) {
    lines.push(`latency p50 ${report.latency_ms.p50.toFixed(0)} ms  p95 ${report.latency_ms.p95.toFixed(0)} ms`);
  }
  if (report.cost_per_1000_usd !== null) {
    lines.push(`cost per 1,000 requests $${report.cost_per_1000_usd.toFixed(4)} at $${report.input_usd_per_million}/M input tokens`);
  }
  lines.push("per tag (binary rows):");
  for (const [tag, metrics] of Object.entries(report.per_tag)) {
    lines.push(
      `  ${tag}: n=${metrics.n_total} recall ${formatRate(metrics.recall)} fpr ${formatRate(metrics.false_positive_rate)} fnr ${formatRate(metrics.false_negative_rate)}`,
    );
  }
  if (report.errors.length > 0) {
    lines.push("errors:");
    for (const error of report.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}
