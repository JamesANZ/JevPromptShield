import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  contentHooksInstalled,
  installContentHooks,
  mergeContentHooks,
} from "../../src/adapters/claude/install.js";

const input = "node /opt/jev/cli.js hook content-input";
const output = "node /opt/jev/cli.js hook content-output";

describe("Claude tool-content installation", () => {
  it("installs pre- and post-tool hooks idempotently without removing others", async () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo bash" }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ command: "echo post" }] }],
      },
    };
    const merged = mergeContentHooks(existing, input, output);
    assert.equal(merged.changed, true);
    assert.equal(contentHooksInstalled(merged.settings), true);
    assert.equal(mergeContentHooks(merged.settings, input, output).changed, false);
    assert.match(JSON.stringify(merged.settings), /echo bash/);
    assert.match(JSON.stringify(merged.settings), /echo post/);

    const dir = await mkdtemp(join(tmpdir(), "jev-content-install-"));
    const path = join(dir, "settings.json");
    await installContentHooks(path, input, output);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(contentHooksInstalled(saved), true);
  });
});
