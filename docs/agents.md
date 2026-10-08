# Future adapters

Claude Code is the only adapter this repository installs. The enforcement core in `src/enforcement/` is agent-independent: an adapter parses a host event into an `ActionContext`, calls `evaluateAction`, and maps `ALLOW`, `ASK`, and `BLOCK` onto whatever that host actually enforces. Do not add an MCP tool as the control. A tool the agent must remember to call is the failure this project is moving away from.

## Claude Code

Native hook: `PreToolUse` with matcher `Bash`.

- Install with `jev-shield setup claude`.
- The hook reads JSON on stdin and writes `hookSpecificOutput.permissionDecision` (`allow`, `ask`, or `deny`) on stdout, then exits 0.
- Docs: [hooks](https://code.claude.com/docs/en/hooks) and [permissions](https://code.claude.com/docs/en/permissions).
- A later expansion can match `Edit|Write` or MCP tool names. The core already accepts a tool name and a command string. The parser would grow a branch per tool.

`ask` is part of the documented PreToolUse contract and, as of Claude Code 2.1.211, forces a prompt in auto mode. Confirm the installed version with `jev-shield doctor`.

## Cursor

Native hook: `beforeShellExecution` in `~/.cursor/hooks.json` or the project hooks file. Input is `{ "command", "cwd", "sandbox" }`. Output is `{ "permission": "allow" | "deny" | "ask" }`.

Docs: [Cursor hooks](https://cursor.com/docs/hooks).

As of March 2026, Cursor staff said only `deny` is enforced. `allow` and `ask` are ignored, including for the sandboxed agent shell ([forum report](https://forum.cursor.com/t/beforeshellexecution-returns-permission-ask-but-sandboxed-agent-shell-still-runs-the-command-sandbox-true/155438)). A Cursor adapter should map both ASK and BLOCK to `deny` until `ask` is actually enforced. Set `failClosed: true` on the hook. Invalid JSON already blocks, but crashes and timeouts fail open unless that flag is set.

`beforeMCPExecution` and `preToolUse` exist for other tools. Shell is the first one worth wiring, using the same `evaluateAction` core.

## OpenAI Codex

Native hook: `PreToolUse`, configured in `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`. Bash commands arrive as `tool_name: "Bash"` and `tool_input.command`. The JSON shape matches Claude Code closely enough that the stdout mapper can be shared.

Docs: [Codex hooks](https://developers.openai.com/codex/hooks).

Codex parses `permissionDecision: "ask"` and does not enforce it. The hook is marked failed and the tool call continues. A Codex adapter should map ASK to `deny`, or handle ASK in `PermissionRequest`, which runs only when Codex was already going to prompt. New or changed hooks stay inactive until a person trusts them with `/hooks`.

## Generic shell wrapper

When a host has no pre-execution hook, the fallback is a command the user or the agent harness actually runs:

```bash
jev-shield exec -- npm test
```

That subcommand is not implemented yet. It would call `evaluateAction` on the arguments, then `exec` the command only after ALLOW, or after a local confirmation for ASK. It is a wrapper, not a daemon. It does not see commands that bypass it.

Docker is a possible later sandbox for commands Shield has allowed. It is separate from the decision, and it is not required to run Shield. Kubernetes is out of scope.
