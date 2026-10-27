import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runDoctor } from "../src/adapters/claude/doctor.js";

describe("doctor media and proxy checks", () => {
  it("checks optional media configuration without making provider calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-shield-doctor-"));
    const report = await runDoctor({
      settingsPath: join(dir, "missing.json"),
      cliPath: process.execPath,
      claudeVersion: "test",
      env: {
        HOME: dir,
        TYPESAFE_API_KEY: "not-used",
        JEV_SHIELD_AUDIT_LOG: join(dir, "audit.jsonl"),
      },
    });
    const checks = new Map(report.checks.map((check) => [check.name, check]));
    assert.equal(checks.get("media_key")?.status, "warn");
    assert.equal(checks.get("media_config")?.status, "ok");
    assert.equal(checks.get("proxy_config")?.status, "ok");
    assert.equal(report.checks.some((check) => check.name === "live_jev"), false);
    assert.equal(JSON.stringify(report).includes("not-used"), false);
  });

  it("fails invalid media and proxy configuration before any live request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-shield-doctor-"));
    const report = await runDoctor({
      settingsPath: join(dir, "missing.json"),
      cliPath: process.execPath,
      claudeVersion: "test",
      env: {
        HOME: dir,
        TYPESAFE_API_KEY: "not-used",
        JEV_SHIELD_AUDIT_LOG: join(dir, "audit.jsonl"),
        JEV_SHIELD_TRANSCRIBE_TIMEOUT_MS: "10",
        JEV_SHIELD_PROXY_SCAN_TIMEOUT_MS: "10",
      },
    });
    const checks = new Map(report.checks.map((check) => [check.name, check]));
    assert.equal(checks.get("media_config")?.status, "fail");
    assert.equal(checks.get("proxy_config")?.status, "fail");
    assert.equal(report.ok, false);
  });
});
