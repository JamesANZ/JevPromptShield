import {
  evaluateAction,
  type EvaluateOptions,
} from "../../enforcement/evaluate.js";
import { isShieldError } from "../../errors.js";
import { claudeHookBody, type ClaudeHookOutput } from "./output.js";
import { parseClaudeHookInput } from "./parse.js";

export interface ClaudeHookResult {
  exitCode: 0;
  body: ClaudeHookOutput;
}

function denied(reason: string): ClaudeHookResult {
  return { exitCode: 0, body: claudeHookBody("BLOCK", reason) };
}

/**
 * Evaluate stdin from Claude Code and return a decision.
 * The process must exit 0. A non-zero exit is a non-blocking error and the command would run.
 */
export async function handleClaudeHook(
  stdin: string,
  options: EvaluateOptions = {},
): Promise<ClaudeHookResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch {
    return denied("Hook input was not valid JSON. Blocked before execution.");
  }
  try {
    const action = parseClaudeHookInput(raw);
    const decision = await evaluateAction(action, options);
    return {
      exitCode: 0,
      body: claudeHookBody(decision.decision, decision.reason),
    };
  } catch (error) {
    const reason = isShieldError(error)
      ? `${error.message} Blocked before execution.`
      : "Prompt Shield could not evaluate the command. Blocked before execution.";
    return denied(reason);
  }
}
