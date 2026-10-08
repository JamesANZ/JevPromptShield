import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveEnforcementConfig } from "../../src/enforcement/config.js";
import { ShieldError } from "../../src/errors.js";

describe("enforcement config", () => {
  it("rejects an unknown fail mode and an out-of-range timeout", () => {
    assert.throws(
      () => resolveEnforcementConfig({ JEV_SHIELD_FAIL_MODE: "open" }),
      (error: unknown) =>
        error instanceof ShieldError && error.code === "invalid_request",
    );
    assert.throws(
      () => resolveEnforcementConfig({ JEV_SHIELD_JEV_TIMEOUT_MS: "50" }),
      (error: unknown) =>
        error instanceof ShieldError && error.code === "invalid_request",
    );
    assert.throws(
      () => resolveEnforcementConfig({ JEV_SHIELD_ENV_CLASS: "prod" }),
      (error: unknown) =>
        error instanceof ShieldError && error.code === "invalid_request",
    );
  });

  it("defaults to ask and reads a valid environment", () => {
    const config = resolveEnforcementConfig({
      JEV_SHIELD_FAIL_MODE: "block",
      JEV_SHIELD_ENV_CLASS: "production",
      JEV_SHIELD_JEV_TIMEOUT_MS: "1000",
      JEV_SHIELD_AUDIT_LOG: "/tmp/jev-shield-test-audit.jsonl",
    });
    assert.equal(config.failMode, "block");
    assert.equal(config.envClass, "production");
    assert.equal(config.jevTimeoutMs, 1000);
    assert.equal(config.auditPath, "/tmp/jev-shield-test-audit.jsonl");
  });
});
