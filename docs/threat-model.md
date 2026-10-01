# Threat model

JEV Shield scores one piece of text before an application passes that text to an LLM or agent. It reports `safe`, `suspicious`, or `malicious`. The application decides whether to quarantine, reject, sanitize, or review. Shield does not authorize tool calls and does not replace a permission layer around external systems.

## Assets

The downstream system may hold a system prompt, developer instructions, credentials, private user data, and tools that can read or change other systems. An attacker wants the model to reveal those assets, send them somewhere else, or abandon the task the application gave it.

## Trust

Developer-controlled system instructions and the application's own policy are trusted. Text the end user writes may assign a task. It may not override higher-priority rules or pull secrets the user was not supposed to see. Webpages, PDFs, emails, retrieved passages, tool results, MCP resources, database rows, and messages from other agents are untrusted data. An instruction aimed at the model is a different event inside that data than the same words typed by the user as their own request.

## In scope

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

Each check is one text blob. The question checklist is static. Adding a category means adding a question and corpus rows, not a new call shape.

## How a decision is made

Untrusted text is placed in Jev `state` together with `source` and `trust`. The questions are fixed strings. Jev returns a probability per question and does not write the verdict. Shield maps the source-conditioned `prompt_injection` probability through configurable thresholds. Category probabilities are reported beside that score. A template builds `reason` from the category names that crossed the suspicious threshold.

## Out of scope

Shield does not make the downstream model incapable of a jailbreak. It does not scan model output in this version. It does not accept images or audio. It does not authenticate end users. It does not decide whether a proposed tool call is authorized. A score can still move because attacker text sits in `state`; published decision-hijacking measurements on Jev found that movement rarely selected an attacker-chosen action, and that adaptive access to scores moved probabilities further. This evaluation is non-adaptive.

Requests that exceed the character cap are rejected. Shield does not silently truncate them into a shorter string and then call it safe.

## What a low score does not mean

A `safe` result means the configured score stayed under the suspicious threshold for this question set. It does not mean the text is harmless to every model, and it does not mean a later tool call should be allowed.
