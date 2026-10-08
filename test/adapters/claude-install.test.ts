import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  claudeHookInstalled,
  installClaudeHook,
  installPromptHook,
  mergeClaudeHook,
  mergePromptHook,
  promptHookInstalled,
} from "../../src/adapters/claude/install.js";
import { ShieldError } from "../../src/errors.js";

const command =
  "/usr/local/bin/node /opt/jev-shield/dist/src/cli.js hook claude";

describe("claude install", () => {
  it("adds a Bash PreToolUse hook and leaves other hooks in place", () => {
    const existing = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo other" }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
    };
    const first = mergeClaudeHook(existing, command);
    assert.equal(first.changed, true);
    assert.equal(
      first.settings.permissions && typeof first.settings.permissions,
      "object",
    );
    const groups = (
      first.settings.hooks as {
        PreToolUse: Array<{ hooks: Array<{ command: string }> }>;
      }
    ).PreToolUse;
    assert.equal(groups[0]?.hooks.length, 2);
    assert.equal(groups[0]?.hooks[0]?.command, "echo other");
    assert.match(groups[0]?.hooks[1]?.command ?? "", /hook claude/);
    assert.equal((first.settings.hooks as { Stop: unknown[] }).Stop.length, 1);

    const second = mergeClaudeHook(first.settings, command);
    assert.equal(second.changed, false);
    assert.equal(claudeHookInstalled(second.settings), true);
  });

  it("writes a settings file and refuses to overwrite invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-shield-settings-"));
    const settingsPath = join(dir, ".claude", "settings.json");
    const installed = await installClaudeHook(settingsPath, command);
    assert.equal(installed.changed, true);
    const again = await installClaudeHook(settingsPath, command);
    assert.equal(again.changed, false);
    const saved = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    assert.equal(claudeHookInstalled(saved), true);

    const broken = join(dir, "broken.json");
    await writeFile(broken, "{");
    await assert.rejects(
      () => installClaudeHook(broken, command),
      (error: unknown) =>
        error instanceof ShieldError && /invalid JSON/.test(error.message),
    );
    assert.equal(await readFile(broken, "utf8"), "{");
  });

  it("adds a UserPromptSubmit hook beside the Bash hook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-shield-prompt-"));
    const settingsPath = join(dir, "settings.json");
    await installClaudeHook(settingsPath, command);
    const promptCommand = command.replace("hook claude", "hook prompt");
    const installed = await installPromptHook(settingsPath, promptCommand);
    assert.equal(installed.changed, true);
    const saved = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    assert.equal(claudeHookInstalled(saved), true);
    assert.equal(promptHookInstalled(saved), true);
    const again = mergePromptHook(saved, promptCommand);
    assert.equal(again.changed, false);
  });
});
