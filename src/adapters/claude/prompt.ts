import { analyze } from "../../analyze.js";
import { isShieldError } from "../../errors.js";
import { createLiveJevClient } from "../../jev/client.js";
import { resolveTypesafeApiKey } from "../../jev/key.js";
import type { AnalyzeResult } from "../../types.js";

const PROMPT_TIMEOUT_MS = 8000;

export async function handlePromptSubmit(
  stdin: string,
  options?: {
    analyze?: (content: string) => Promise<AnalyzeResult>;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ exitCode: 0; body: Record<string, unknown> }> {
  let prompt: string;
  try {
    const input = JSON.parse(stdin) as { prompt?: unknown };
    if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
      return block("Prompt Shield did not receive a prompt to check.");
    }
    prompt = input.prompt;
  } catch {
    return block("Prompt Shield received malformed hook input.");
  }

  const env = options?.env ?? process.env;
  const apiKey = resolveTypesafeApiKey(env);
  if (!apiKey) {
    return block(
      "TYPESAFE_API_KEY was not found in the environment or in Claude/Cursor MCP config, so this prompt was not scored.",
    );
  }

  try {
    const result = options?.analyze
      ? await options.analyze(prompt)
      : await analyze(
          { content: prompt, source: "user" },
          {
            client: createLiveJevClient({
              apiKey,
              timeoutMs: PROMPT_TIMEOUT_MS,
            }),
          },
        );
    if (result.safe) return { exitCode: 0, body: {} };
    return block(
      `Jev scored this prompt as ${result.verdict} (${result.risk} risk, score ${result.score.toFixed(2)}). ${result.reason}`,
    );
  } catch (error) {
    const message = isShieldError(error)
      ? error.message
      : "Jev could not score this prompt.";
    return block(message);
  }
}

function block(reason: string): {
  exitCode: 0;
  body: Record<string, unknown>;
} {
  return { exitCode: 0, body: { decision: "block", reason } };
}
