import type { Decision } from "../../enforcement/types.js";

export interface ClaudeHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "ask" | "deny";
    permissionDecisionReason: string;
  };
}

export function claudePermission(
  decision: Decision,
): ClaudeHookOutput["hookSpecificOutput"]["permissionDecision"] {
  if (decision === "ALLOW") return "allow";
  if (decision === "ASK") return "ask";
  return "deny";
}

export function claudeHookBody(
  decision: Decision,
  reason: string,
): ClaudeHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: claudePermission(decision),
      permissionDecisionReason: reason,
    },
  };
}
