import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(stdin ?? "");
  return once(child, "exit").then(([code]) => ({
    code: code as number | null,
    stdout,
    stderr,
  }));
}

describe("gate cli", () => {
  it("runs the local self-check without an API key", async () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const result = await runCli(["test"], env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /ALLOW/);
    assert.match(result.stdout, /BLOCK/);
    assert.match(result.stdout, /"ok": true/);
  });

  it("installs a Claude hook, reports doctor status, and denies a pre-baked allow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-shield-cli-"));
    const settings = join(dir, "settings.json");
    const audit = join(dir, "audit.jsonl");
    const env = {
      ...process.env,
      TYPESAFE_API_KEY: "test-key-not-used",
      JEV_SHIELD_AUDIT_LOG: audit,
      JEV_SHIELD_FAIL_MODE: "ask",
      JEV_SHIELD_ENV_CLASS: "dev",
    };
    const setup = await runCli(
      ["setup", "claude", "--settings", settings],
      env,
    );
    assert.equal(setup.code, 0);
    assert.match(setup.stdout, /Installed/);
    const again = await runCli(
      ["setup", "claude", "--settings", settings],
      env,
    );
    assert.match(again.stdout, /Already installed/);

    const doctor = await runCli(["doctor", "--settings", settings], env);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /hook: ok/);
    assert.match(doctor.stdout, /prompt: ok/);
    assert.match(doctor.stdout, /api_key: ok/);
    assert.equal(doctor.stdout.includes("test-key-not-used"), false);

    const missing = await runCli(
      ["doctor", "--settings", join(dir, "missing.json")],
      env,
    );
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /hook: fail/);

    const blocked = await runCli(
      ["hook", "claude"],
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        permissionDecision: "allow",
      }),
    );
    assert.equal(blocked.code, 0);
    const body = JSON.parse(blocked.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(body.hookSpecificOutput.permissionDecision, "deny");

    const malformed = await runCli(["hook", "claude"], env, "{");
    assert.equal(malformed.code, 0);
    const denied = JSON.parse(malformed.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  });

  it("refuses to install an adapter that is not available yet", async () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const result = await runCli(["setup", "cursor"], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /docs\/agents.md/);
  });
});
