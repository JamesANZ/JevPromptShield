import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.js";
import { decisionFromScores } from "../src/jev/client.js";

describe("mixed-message http", () => {
  it("returns aggregate and per-part verdicts", async () => {
    const server = createServer({
      client: {
        async decide(input) {
          return decisionFromScores({
            prompt_injection: input.content.includes("attack") ? 0.9 : 0.01,
          });
        },
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/analyze-message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "user",
            parts: [
              { type: "text", content: "ordinary request" },
              { type: "text", content: "attack", source: "webpage" },
            ],
          }),
        },
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        safe: boolean;
        parts: { source: string; result: { safe: boolean } }[];
      };
      assert.equal(body.safe, false);
      assert.deepEqual(
        body.parts.map((part) => [part.source, part.result.safe]),
        [
          ["user", true],
          ["webpage", false],
        ],
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
