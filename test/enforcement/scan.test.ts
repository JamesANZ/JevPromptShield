import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanCommand } from "../../src/enforcement/scan.js";

describe("scan", () => {
  it("splits a simple command and keeps quoted operators inside one argument", () => {
    const quoted = scanCommand('echo "hello && world"');
    assert.equal(quoted.simple, true);
    assert.deepEqual(quoted.argv, ["echo", "hello && world"]);
  });

  it("keeps an escaped space inside one word and a hash inside quotes", () => {
    assert.deepEqual(scanCommand("echo hello\\ world").argv, [
      "echo",
      "hello world",
    ]);
    assert.deepEqual(scanCommand('echo "foo # bar"').argv, ["echo", "foo # bar"]);
    assert.deepEqual(scanCommand("echo foo#bar").argv, ["echo", "foo#bar"]);
  });

  it("treats a hash that starts a word as a comment, and a following line as another command", () => {
    const commented = scanCommand("git status # && rm -rf /");
    assert.equal(commented.simple, true);
    assert.deepEqual(commented.argv, ["git", "status"]);
    assert.equal(scanCommand("ls # note\nrm").simple, false);
    assert.equal(scanCommand('echo "unterminated').simple, false);
    assert.equal(scanCommand("echo trailing\\").simple, false);
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
