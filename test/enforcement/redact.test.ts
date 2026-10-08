import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactText } from "../../src/enforcement/redact.js";

describe("redact", () => {
  it("strips credential-shaped substrings and leaves the command readable", () => {
    const command =
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://user:pw@example.com/x api_key=supersecretvalue";
    const redacted = redactText(command);
    assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(redacted.includes("supersecretvalue"), false);
    assert.equal(redacted.includes("user:pw@"), false);
    assert.match(redacted, /Bearer \[redacted\]/);
    assert.match(redacted, /api_key=\[redacted\]/);
    assert.match(redacted, /curl/);
  });
});
