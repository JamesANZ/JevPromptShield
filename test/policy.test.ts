import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THRESHOLDS, resolveThresholds } from "../src/config.js";
import { decisionFromScores } from "../src/jev/client.js";
import { applyPolicy } from "../src/engine/policy.js";
import { ShieldError } from "../src/errors.js";

const thresholds = DEFAULT_THRESHOLDS;

describe("policy", () => {
  it("marks a low primary score safe and keeps secondary spikes in signals only", () => {
    const result = applyPolicy(
      decisionFromScores({ prompt_injection: 0.1, instruction_override: 0.95 }),
      thresholds,
    );
    assert.equal(result.safe, true);
    assert.equal(result.verdict, "safe");
    assert.equal(result.risk, "low");
    assert.deepEqual(result.categories, []);
    assert.equal(result.signals.instruction_override?.triggered, true);
    assert.match(result.reason, /No attack signal crossed/);
  });

  it("uses the suspicious band at the threshold and includes triggered categories", () => {
    const result = applyPolicy(
      decisionFromScores(
        { prompt_injection: 0.4, instruction_override: 0.4, data_exfiltration: 0.39 },
        { content_role: "model_instruction", content_role_probability: 0.8 },
      ),
      thresholds,
    );
    assert.equal(result.safe, false);
    assert.equal(result.verdict, "suspicious");
    assert.equal(result.risk, "medium");
    assert.deepEqual(result.categories, ["prompt_injection", "instruction_override"]);
    assert.match(result.reason, /override trusted instructions/);
    assert.equal(result.content_role, "model_instruction");
  });

  it("marks the malicious threshold as high risk", () => {
    const result = applyPolicy(decisionFromScores({ prompt_injection: 0.75 }), thresholds);
    assert.equal(result.verdict, "malicious");
    assert.equal(result.risk, "high");
    assert.equal(result.safe, false);
    assert.ok(result.usage.estimated_cost_usd > 0);
  });

  it("rejects a suspicious threshold that is not below malicious", () => {
    assert.throws(
      () => resolveThresholds({ suspicious: 0.8, malicious: 0.8 }),
      (error: unknown) => error instanceof ShieldError && error.code === "invalid_request",
    );
  });
});
