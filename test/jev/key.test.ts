import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveTypesafeApiKey } from "../../src/jev/key.js";

describe("TypeSafe key discovery", () => {
  it("reads TYPESAFE_API_KEY from an MCP config env block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-shield-key-"));
    const file = join(dir, "mcp.json");
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          "medical-mcp": { env: { TYPESAFE_API_KEY: "config-key-not-used" } },
        },
      }),
    );
    const key = resolveTypesafeApiKey({
      JEV_SHIELD_MCP_CONFIG: file,
    });
    assert.equal(key, "config-key-not-used");
  });

  it("prefers the process environment over a config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-shield-key-"));
    const file = join(dir, "mcp.json");
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { demo: { env: { TYPESAFE_API_KEY: "from-file" } } },
      }),
    );
    const key = resolveTypesafeApiKey({
      TYPESAFE_API_KEY: "from-env",
      JEV_SHIELD_MCP_CONFIG: file,
    });
    assert.equal(key, "from-env");
  });
});
