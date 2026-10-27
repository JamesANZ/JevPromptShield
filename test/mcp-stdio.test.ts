import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

describe("MCP stdio command", () => {
  it("starts the built CLI and answers tools/list without provider keys", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "mcp"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      assert.equal(result.tools.length, 4);
    } finally {
      await client.close();
    }
  });
});
