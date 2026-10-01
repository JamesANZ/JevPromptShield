import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THRESHOLDS, JEV_INPUT_USD_PER_MILLION } from "../src/config.js";
import { CORPUS_TAGS } from "../src/eval/corpus.js";
import { buildEvalReport, classMetrics, percentile, type ScoredCase } from "../src/eval/metrics.js";
import { splitForId } from "../src/eval/split.js";
import type { Verdict } from "../src/types.js";

function row(partial: Partial<ScoredCase> & Pick<ScoredCase, "id" | "expectedVerdict" | "predictedVerdict" | "score">): ScoredCase {
  return {
    tags: partial.tags ?? [],
    expectedCategories: partial.expectedCategories ?? [],
    sourceBlindScore: partial.sourceBlindScore ?? partial.score,
    categoryUnionHit: partial.categoryUnionHit ?? (partial.predictedVerdict !== "safe"),
    triggeredCategories: partial.triggeredCategories ?? [],
    latencyMs: partial.latencyMs ?? null,
    inputTokens: partial.inputTokens ?? null,
    ...partial,
  };
}

describe("metrics", () => {
  it("computes detection, false positives, and the strict cut", () => {
    const rows = [
      row({ id: "a", expectedVerdict: "malicious", predictedVerdict: "malicious", score: 0.9 }),
      row({ id: "b", expectedVerdict: "malicious", predictedVerdict: "suspicious", score: 0.5 }),
      row({ id: "c", expectedVerdict: "malicious", predictedVerdict: "safe", score: 0.1 }),
      row({ id: "d", expectedVerdict: "safe", predictedVerdict: "suspicious", score: 0.6 }),
      row({ id: "e", expectedVerdict: "safe", predictedVerdict: "safe", score: 0.05 }),
      row({ id: "f", expectedVerdict: "suspicious" as Verdict, predictedVerdict: "safe", score: 0.2 }),
    ];
    const binary = classMetrics(rows, (item) => item.predictedVerdict !== "safe");
    assert.equal(binary.n, 5);
    assert.equal(binary.tp, 2);
    assert.equal(binary.fn, 1);
    assert.equal(binary.fp, 1);
    assert.equal(binary.tn, 1);
    assert.equal(binary.recall, 2 / 3);
    assert.equal(binary.false_positive_rate, 0.5);
    assert.equal(binary.false_negative_rate, 1 / 3);
    const strict = classMetrics(rows, (item) => item.predictedVerdict === "malicious");
    assert.equal(strict.tp, 1);
    assert.equal(strict.fp, 0);
  });

  it("omits latency and cost for fixture mode and reports a live cost from tokens", () => {
    const rows = [
      row({
        id: "a",
        tags: ["encoded"],
        expectedVerdict: "malicious",
        predictedVerdict: "safe",
        score: 0.1,
        sourceBlindScore: 0.8,
        categoryUnionHit: true,
        latencyMs: 100,
        inputTokens: 1000,
      }),
      row({
        id: "b",
        tags: ["encoded"],
        expectedVerdict: "safe",
        predictedVerdict: "safe",
        score: 0.1,
        latencyMs: 300,
        inputTokens: 1000,
      }),
    ];
    const fixture = buildEvalReport({
      mode: "fixture",
      rows,
      errors: [],
      split: "test",
      thresholds: DEFAULT_THRESHOLDS,
      questionSetVersion: "2026-10-01.1",
      policyVersion: "2026-10-01.1",
      inputUsdPerMillion: JEV_INPUT_USD_PER_MILLION,
      tags: [...CORPUS_TAGS],
    });
    assert.equal(fixture.latency_ms, null);
    assert.equal(fixture.cost_per_1000_usd, null);
    assert.equal(fixture.per_tag.encoded?.fn, 1);
    const live = buildEvalReport({
      mode: "live",
      rows,
      errors: [],
      split: "test",
      thresholds: DEFAULT_THRESHOLDS,
      questionSetVersion: "2026-10-01.1",
      policyVersion: "2026-10-01.1",
      inputUsdPerMillion: JEV_INPUT_USD_PER_MILLION,
      tags: ["encoded"],
    });
    assert.equal(live.latency_ms?.p50, 100);
    assert.equal(live.latency_ms?.p95, 300);
    assert.ok(Math.abs((live.cost_per_1000_usd ?? 0) - 0.042) < 1e-9);
    assert.ok((live.source_blind.recall ?? 0) > (live.binary.recall ?? 0));
  });

  it("uses nearest-rank percentiles and a stable split", () => {
    assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
    assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
    assert.equal(splitForId("benign-data-01"), splitForId("benign-data-01"));
    assert.ok(splitForId("benign-data-01") === "dev" || splitForId("benign-data-01") === "test");
  });
});
