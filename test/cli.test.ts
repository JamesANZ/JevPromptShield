import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createLiveJevClient } from "../src/jev/client.js";
import { ShieldError } from "../src/errors.js";
import { fileURLToPath } from "node:url";

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  return once(child, "exit").then(([code]) => ({ code: code as number | null, stdout, stderr }));
}

describe("cli", () => {
  it("refuses a live eval when the API key is absent", async () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const result = await runCli(["eval", "--split", "test"], env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Refusing to invent scores/);
  });

  it("prints corpus counts without calling Jev", async () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const result = await runCli(["corpus"], env);
    assert.equal(result.code, 0);
    const body = JSON.parse(result.stdout) as { n: number; dev: number; test: number };
    assert.ok(body.n >= 100);
    assert.ok(body.dev > 0);
    assert.ok(body.test > 0);
  });

  it("maps a missing TypeSafe key to an auth error", () => {
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      assert.throws(
        () => createLiveJevClient(),
        (error: unknown) => error instanceof ShieldError && error.code === "jev_auth",
      );
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });
});
