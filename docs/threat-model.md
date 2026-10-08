# Threat model

JEV Shield has two jobs. The action gate decides whether a proposed shell command may run. The content scorer rates one piece of text for prompt injection before an application passes that text to a model. They use different question sets. A destructive command is not a prompt injection, and a high injection score does not by itself authorize a tool call.

Claude Code `UserPromptSubmit` sends every submitted prompt through the content scorer. A result that is not safe, and any Jev error, blocks the prompt. The TypeSafe key comes from `TYPESAFE_API_KEY` or from an MCP `env` block in Cursor, Claude Desktop, or `~/.claude.json`. If the hook host times out before Shield answers, Claude Code discards the output and the prompt still proceeds.

## Action gate

### Assets

The machine under the coding agent can hold source, credentials, production data, and git history. An agent with a shell can delete them, rewrite shared branches, or run a downloaded script. The asset is the ability to run that command.

### Trust

The agent is untrusted as an enforcement mechanism. Its tool call is a proposal. The hook process, the local policy, and the Jev action questions are the enforcement path. Developer-configured fail mode, environment class, and Claude's own deny rules are trusted configuration. The agent's `description` field is untrusted text and is labeled that way when it is sent to Jev.

### In scope

- Claude Code `Bash` `PreToolUse` events, including subagent Bash calls.
- Local ALLOW for a short list of single, read-only commands with no shell syntax.
- Local BLOCK for root or home wipes, filesystem formatters, fork bombs, raw disk writes, force-pushes to `main` or `master`, and obvious prompt-injection tricks such as instruction overrides and the "I have been pwned" canary. The trick check folds the command and the agent description, so zero-width characters and an `echo` wrapper do not hide them.
- Jev review for everything else, including a remote script piped into a shell and a force-push of some other branch.
- Redaction of credential-shaped substrings before Jev and before the audit log.
- Fail mode `ask` or `block` when Jev errors. Local decisions stand either way.
- Denial of malformed hook input and invalid gate configuration.

### How a decision is made

The hook parses stdin into a command, working directory, and agent name. It does not read a pre-baked allow from that JSON. Local policy runs first. A command is a local ALLOW only when a quote-aware scan proves it is one simple command and the executable is on the read-only list. `git status && rm -rf /tmp/app` is not that. Catastrophic patterns block even inside a compound command.

If the local policy does not decide, Shield sends Jev the redacted command, cwd, git branch name, environment class, tool name, and a capped description. It does not send the process environment, file contents, or the transcript. Jev answers a disposition choice (`allow`, `ask`, `block`) and an irreversible-harm probability. Confidence below 0.7 becomes ASK. Irreversible harm at or above 0.75 becomes BLOCK. The action question set is version `2026-10-08.1`.

The hook prints `permissionDecision` and exits 0. Exit code 1 would be a non-blocking error, and the command would run.

### Out of scope

The hook protects Bash calls that pass through it. It does not sandbox the operating system, the user's own terminal, `@` file mentions, or tools that are not `Bash`. An allowed command can start another process. `disableAllHooks`, removing the settings entry, or an enterprise policy that drops user hooks removes the gate. Command-hook timeout behavior is not clearly fail-closed in the Claude Code docs, so Shield returns a decision inside its own timeout. Cursor and Codex `ask` decisions are not enforced by those hosts today. See [agents.md](agents.md).

A low injection score on a piece of text still says nothing about a later tool call. That is the content scorer, below.

## Content scoring

The content scorer rates one piece of text before an application passes that text to an LLM or agent. It reports `safe`, `suspicious`, or `malicious`. The application decides whether to quarantine, reject, sanitize, or review. The scorer does not authorize tool calls. The action gate above is the permission layer for Claude Code Bash.

### Assets

The downstream system may hold a system prompt, developer instructions, credentials, private user data, and tools that can read or change other systems. An attacker wants the model to reveal those assets, send them somewhere else, or abandon the task the application gave it.

### Trust

Developer-controlled system instructions and the application's own policy are trusted. Text the end user writes may assign a task. It may not override higher-priority rules or pull secrets the user was not supposed to see. Webpages, PDFs, emails, retrieved passages, tool results, MCP resources, database rows, and messages from other agents are untrusted data. An instruction aimed at the model is a different event inside that data than the same words typed by the user as their own request.

### In scope

- Direct prompt injection
- Indirect prompt injection carried by retrieved or third-party content
- Instruction-hierarchy attacks, including "ignore previous instructions"
- System-prompt extraction
- Credential and secret extraction
- Data-exfiltration instructions
- Malicious tool-use instructions
- Encoded or otherwise obfuscated instructions
- Privileged role impersonation
- Hostile instructions embedded in content that otherwise looks legitimate

Each check is one text blob. The question checklist is static. Adding a category means adding a question and corpus rows, not a new call shape. Question text is version `2026-10-01.1`.

### How a decision is made

Untrusted text is placed in Jev `state` together with `source` and `trust`. The questions are fixed strings. Jev returns a probability per question and does not write the verdict. Shield maps the source-conditioned `prompt_injection` probability through configurable thresholds. Category probabilities are reported beside that score. A template builds `reason` from the category names that crossed the suspicious threshold.

### Out of scope

The scorer does not make the downstream model incapable of a jailbreak. It does not scan model output in this version. It does not accept images or audio. It does not authenticate end users. A score can still move because attacker text sits in `state`; published decision-hijacking measurements on Jev found that movement rarely selected an attacker-chosen action, and that adaptive access to scores moved probabilities further. This evaluation is non-adaptive.

Requests that exceed the character cap are rejected. Shield does not silently truncate them into a shorter string and then call it safe.

### What a low score does not mean

A `safe` result means the configured score stayed under the suspicious threshold for this question set. It does not mean the text is harmless to every model, and it does not mean a later tool call should be allowed. Tool calls go through the action gate.
