import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionFromJudgement } from "../../src/enforcement/policy.js";

describe("action judgement transitions", () => {
  it("blocks high irreversible harm before trusting an allow disposition", () => {
    const choice = decisionFromJudgement({
      disposition: "allow",
      confidence: 0.99,
      irreversible: 0.75,
      model: "fixture",
      input_tokens: 1,
      output_tokens: 1,
    });
    assert.equal(choice.decision, "BLOCK");
    assert.match(choice.reason, /irreversible/);
  });

  it("asks when a block disposition is below the confidence floor", () => {
    const choice = decisionFromJudgement({
      disposition: "block",
      confidence: 0.4,
      irreversible: 0.1,
      model: "fixture",
      input_tokens: 1,
      output_tokens: 1,
    });
    assert.equal(choice.decision, "ASK");
  });

  it("asks when an allow disposition still carries moderate irreversible harm", () => {
    const choice = decisionFromJudgement({
      disposition: "allow",
      confidence: 0.99,
      irreversible: 0.4,
      model: "fixture",
      input_tokens: 1,
      output_tokens: 1,
    });
    assert.equal(choice.decision, "ASK");
  });
});
