import { ShieldError } from "../../errors.js";
import type { ActionContext } from "../../enforcement/types.js";

/** Read a Claude Code PreToolUse payload. Decision fields in the payload are ignored. */
export function parseClaudeHookInput(raw: unknown): ActionContext {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShieldError(
      "invalid_request",
      "Hook input must be a JSON object.",
    );
  }
  const body = raw as Record<string, unknown>;
  if (
    body.hook_event_name !== undefined &&
    body.hook_event_name !== "PreToolUse"
  ) {
    throw new ShieldError(
      "invalid_request",
      "Hook input is not a PreToolUse event.",
    );
  }
  if (body.tool_name !== "Bash") {
    throw new ShieldError(
      "invalid_request",
      "This hook only evaluates Bash tool calls.",
    );
  }
  const toolInput = body.tool_input;
  if (
    toolInput === null ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput)
  ) {
    throw new ShieldError("invalid_request", "Bash tool input is missing.");
  }
  const input = toolInput as Record<string, unknown>;
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new ShieldError(
      "invalid_request",
      "Bash tool input is missing a command.",
    );
  }

  const action: ActionContext = {
    command: input.command,
    tool: "Bash",
    agent:
      typeof body.agent_type === "string" && body.agent_type !== ""
        ? body.agent_type
        : "claude-code",
  };
  if (typeof body.cwd === "string" && body.cwd !== "") action.cwd = body.cwd;
  if (typeof input.description === "string" && input.description !== "")
    action.description = input.description;
  return action;
}
