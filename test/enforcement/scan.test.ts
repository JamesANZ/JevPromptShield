import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanCommand } from "../../src/enforcement/scan.js";

describe("scan", () => {
  it("splits a simple command and keeps quoted operators inside one argument", () => {
    const quoted = scanCommand('echo "hello && world"');
    assert.equal(quoted.simple, true);
    assert.deepEqual(quoted.argv, ["echo", "hello && world"]);
  });

  it("rejects compound commands, substitutions, and redirects", () => {
    for (const command of [
      "git status && rm -rf /tmp/app",
      "echo $(id)",
      "cat file > /tmp/out",
      "ls\nrm",
    ]) {
      const scanned = scanCommand(command);
      assert.equal(scanned.simple, false, command);
      assert.deepEqual(scanned.argv, []);
    }
  });
});
