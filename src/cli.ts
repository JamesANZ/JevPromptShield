#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  commandVersion,
  formatDoctor,
  runDoctor,
} from "./adapters/claude/doctor.js";
import { handleClaudeHook } from "./adapters/claude/hook.js";
import { handlePromptSubmit } from "./adapters/claude/prompt.js";
import {
  handleClaudeContentInput,
  handleClaudeContentOutput,
} from "./adapters/claude/content.js";
import {
  claudeContentInputHookCommand,
  claudeContentOutputHookCommand,
  claudeHookCommand,
  claudePromptHookCommand,
  installClaudeHook,
  installContentHooks,
  installPromptHook,
} from "./adapters/claude/install.js";
import { runSelfCheck } from "./enforcement/self-check.js";
import { analyze } from "./analyze.js";
import { compareDocuments } from "./compare.js";
import { createServer } from "./api/server.js";
import { createOpenAiProxyServer } from "./proxy.js";
import { startMcpServer } from "./mcp/server.js";
import { isShieldError, ShieldError } from "./errors.js";
import { attachmentKind, mediaTypeForFilename } from "./media/transcribe.js";
import { loadCorpus } from "./eval/corpus.js";
import { CORPUS_TAGS } from "./eval/corpus.js";
import { SOURCES, type CompareDocument, type Source } from "./types.js";
import { evaluateCorpus, formatReport, selectSplit } from "./eval/run.js";
import { loadCanary, runCanary } from "./eval/canary.js";
import {
  formatGandalfReport,
  loadGandalf,
  runGandalfPrecheck,
} from "./eval/gandalf.js";
import { resolveTypesafeApiKey } from "./jev/key.js";
import { runBaseline, selectBaseline } from "./eval/baseline.js";
import { evaluatePublicSet, loadPublicCases } from "./eval/public-set.js";
import { createLiveJevClient } from "./jev/client.js";
import type { JevDecision } from "./engine/policy.js";
import { splitForId } from "./eval/split.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printResult(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function readFlags() {
  const command = process.argv[2] ?? "help";
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      source: { type: "string" },
      file: { type: "string" },
      content: { type: "string" },
      image: { type: "string" },
      audio: { type: "string" },
      context: { type: "string" },
      split: { type: "string", default: "test" },
      fixture: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      baseline: { type: "boolean", default: false },
      canary: { type: "boolean", default: false },
      corpus: { type: "string" },
    },
    strict: true,
  });
  return { command, values };
}

async function loadFixtures(path: string): Promise<Map<string, JevDecision>> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  const fixtures = new Map<string, JevDecision>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const raw = JSON.parse(line) as { id?: string; decision?: JevDecision };
    if (!raw.id || !raw.decision)
      throw new Error("Each fixture line needs id and decision.");
    fixtures.set(raw.id, raw.decision);
  }
  return fixtures;
}

function gateSettingsPath(values: {
  project?: boolean;
  settings?: string;
}): string {
  if (values.settings) return resolve(values.settings);
  if (values.project) return resolve(process.cwd(), ".claude", "settings.json");
  return join(homedir(), ".claude", "settings.json");
}

async function runGateCommand(command: string): Promise<void> {
  if (command === "test") {
    if (process.argv.length > 3) fail("jev-shield test takes no arguments.");
    const report = await runSelfCheck();
    printResult(report);
    if (!report.ok) fail("Self-check failed.", 1);
    return;
  }

  if (command === "hook") {
    const which = process.argv[3];
    if (
      which !== "claude" &&
      which !== "prompt" &&
      which !== "content-input" &&
      which !== "content-output"
    ) {
      fail("Usage: jev-shield hook claude|prompt|content-input|content-output");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const stdin = Buffer.concat(chunks).toString("utf8");
    const result =
      which === "claude"
        ? await handleClaudeHook(stdin)
        : which === "prompt"
          ? await handlePromptSubmit(stdin)
          : which === "content-input"
            ? await handleClaudeContentInput(stdin)
            : await handleClaudeContentOutput(stdin);
    process.stdout.write(`${JSON.stringify(result.body)}\n`);
    return;
  }

  const { values } = parseArgs({
    args: process.argv.slice(command === "setup" ? 4 : 3),
    options: {
      project: { type: "boolean", default: false },
      settings: { type: "string" },
      live: { type: "boolean", default: false },
    },
    strict: true,
  });
  const settingsPath = gateSettingsPath(values);

  if (command === "setup") {
    if (process.argv[3] !== "claude") {
      fail(
        "Claude Code is the installable adapter in this version. Cursor and Codex are described in docs/agents.md.",
      );
    }
    const cliPath = fileURLToPath(import.meta.url);
    const bash = await installClaudeHook(
      settingsPath,
      claudeHookCommand(process.execPath, cliPath),
    );
    const prompt = await installPromptHook(
      settingsPath,
      claudePromptHookCommand(process.execPath, cliPath),
    );
    const content = await installContentHooks(
      settingsPath,
      claudeContentInputHookCommand(process.execPath, cliPath),
      claudeContentOutputHookCommand(process.execPath, cliPath),
    );
    process.stdout.write(
      `${bash.changed || prompt.changed || content.changed ? "Installed" : "Already installed"} Claude Code hooks in ${settingsPath}\n`,
    );
    return;
  }

  if (command === "doctor") {
    const report = await runDoctor({
      settingsPath,
      cliPath: fileURLToPath(import.meta.url),
      claudeVersion: await commandVersion("claude"),
      live: values.live,
    });
    process.stdout.write(formatDoctor(report.checks));
    if (!report.ok) fail("Doctor found a problem.", 1);
    return;
  }

  fail(`Unknown command ${command}. Run jev-shield help.`);
}

async function loadCompareDocument(
  path: string,
  forced?: "image" | "audio" | "text",
): Promise<CompareDocument> {
  const { readFile } = await import("node:fs/promises");
  const name = basename(path);
  const kind = forced ?? attachmentKind(path);
  if (kind === "image") {
    return {
      name,
      image: {
        media_type: mediaTypeForFilename(path, "image"),
        data: await readFile(path),
      },
    };
  }
  if (kind === "audio") {
    return {
      name,
      audio: {
        media_type: mediaTypeForFilename(path, "audio"),
        data: await readFile(path),
      },
    };
  }
  const bytes = await readFile(path);
  if (bytes.includes(0)) {
    throw new ShieldError(
      "invalid_request",
      `${name} is not a text document. Pass text, or an image of the page.`,
    );
  }
  return { name, content: bytes.toString("utf8") };
}

async function runCompare(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      question: { type: "string" },
      file: { type: "string", multiple: true },
      image: { type: "string", multiple: true },
      audio: { type: "string", multiple: true },
      threshold: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (!values.question || values.question.trim() === "") {
    fail(
      'Pass --question, for example --question "Which document mentions Gerald?"',
    );
  }
  const tagged: { path: string; kind?: "image" | "audio" | "text" }[] = [
    ...(values.file ?? []).map((path) => ({ path, kind: "text" as const })),
    ...(values.image ?? []).map((path) => ({ path, kind: "image" as const })),
    ...(values.audio ?? []).map((path) => ({ path, kind: "audio" as const })),
    ...positionals.map((path) => ({ path })),
  ];
  if (tagged.length < 2) {
    fail("Attach at least two documents. Pass paths, or repeat --file.");
  }
  let threshold: number | undefined;
  if (values.threshold !== undefined) {
    threshold = Number(values.threshold);
    if (values.threshold.trim() === "" || !Number.isFinite(threshold)) {
      fail("--threshold must be a number from 0 to 1.");
    }
  }
  try {
    const documents = [];
    for (const item of tagged) {
      documents.push(await loadCompareDocument(item.path, item.kind));
    }
    const result = await compareDocuments({
      question: values.question,
      documents,
      ...(threshold !== undefined ? { threshold } : {}),
    });
    printResult(result);
  } catch (error) {
    if (isShieldError(error)) {
      fail(
        JSON.stringify({
          error: { code: error.code, message: error.message },
        }),
      );
    }
    const message = error instanceof Error ? error.message : "Compare failed.";
    fail(message);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (
    command === "setup" ||
    command === "doctor" ||
    command === "test" ||
    command === "hook"
  ) {
    await runGateCommand(command);
    return;
  }
  if (command === "mcp") {
    await startMcpServer();
    return;
  }
  if (command === "compare") {
    await runCompare();
    return;
  }
  const { values } = await readFlags();
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`jev-shield setup claude [--project] [--settings path]
jev-shield doctor [--project] [--settings path] [--live]
jev-shield test
jev-shield hook claude
jev-shield hook prompt
jev-shield hook content-input
jev-shield hook content-output
jev-shield mcp
jev-shield analyze --source webpage --file page.txt
jev-shield analyze --source user --content "text"
jev-shield analyze --source webpage --image shot.png
jev-shield analyze --source user --audio note.mp3
jev-shield compare --question "Which document mentions Gerald?" notes.txt clinic.txt
jev-shield serve [--port 8787] [--host 127.0.0.1]
jev-shield proxy [--port 8788] [--host 127.0.0.1]
jev-shield corpus
jev-shield eval [--split test|dev|all] [--fixture scores.jsonl] [--baseline] [--canary]
jev-shield eval-public --file external.jsonl
jev-shield gandalf

setup installs a Claude Code Bash PreToolUse hook and a UserPromptSubmit hook that scores every prompt with Jev. test runs local fixtures and does not call Jev.
compare asks one question of two to eight documents and lists every document that matches. Text, images, and audio can be mixed. A PDF page needs to be text or an image.
Live eval needs TYPESAFE_API_KEY. Without a key or a fixture file, eval exits 2 and does not invent scores.
gandalf scores the published Gandalf solutions with Shield before a defender call and prints that pre-check report.
`);
    return;
  }

  if (command === "serve") {
    const port = Number(values.port ?? process.env.JEV_SHIELD_PORT ?? 8787);
    const host = values.host ?? process.env.JEV_SHIELD_HOST ?? "127.0.0.1";
    const server = createServer();
    server.listen(port, host, () => {
      process.stderr.write(`JEV Shield listening on http://${host}:${port}\n`);
    });
    return;
  }

  if (command === "proxy") {
    const port = Number(
      values.port ?? process.env.JEV_SHIELD_PROXY_PORT ?? 8788,
    );
    const host =
      values.host ?? process.env.JEV_SHIELD_PROXY_HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      fail("The guarded proxy only listens on a loopback host.");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail("Proxy port must be an integer from 1 to 65535.");
    }
    const server = createOpenAiProxyServer();
    server.listen(port, host, () => {
      process.stderr.write(
        `JEV Shield guarded proxy listening on http://${host}:${port}/v1/chat/completions\n`,
      );
    });
    return;
  }

  if (command === "analyze") {
    const inputs = [
      values.content,
      values.file,
      values.image,
      values.audio,
    ].filter((value) => value !== undefined);
    if (inputs.length !== 1) {
      fail("Pass one of --content, --file, --image, or --audio.");
    }
    if (!values.source || !SOURCES.includes(values.source as Source)) {
      fail(
        "Pass --source (user, webpage, pdf, email, rag, tool, mcp, agent, database, unknown).",
      );
    }
    const source = values.source as Source;
    const context = values.context ? { context: values.context } : {};
    try {
      const { readFile } = await import("node:fs/promises");
      const result = values.image
        ? await analyze({
            image: {
              media_type: mediaTypeForFilename(values.image, "image"),
              data: await readFile(values.image),
            },
            source,
            ...context,
          })
        : values.audio
          ? await analyze({
              audio: {
                media_type: mediaTypeForFilename(values.audio, "audio"),
                data: await readFile(values.audio),
              },
              source,
              ...context,
            })
          : await analyze({
              content: values.file
                ? await readFile(values.file, "utf8")
                : values.content,
              source,
              ...context,
            });
      printResult(result);
    } catch (error) {
      if (isShieldError(error))
        fail(
          JSON.stringify({
            error: { code: error.code, message: error.message },
          }),
        );
      throw error;
    }
    return;
  }

  if (command === "corpus") {
    const cases = await loadCorpus(
      values.corpus ?? resolve(root, "corpus/cases.jsonl"),
    );
    const byTag = Object.fromEntries(
      CORPUS_TAGS.map((tag) => [
        tag,
        cases.filter((item) => item.tags.includes(tag)).length,
      ]),
    );
    printResult({
      n: cases.length,
      dev: cases.filter((item) => splitForId(item.id) === "dev").length,
      test: cases.filter((item) => splitForId(item.id) === "test").length,
      by_verdict: {
        safe: cases.filter((item) => item.expected.verdict === "safe").length,
        suspicious: cases.filter(
          (item) => item.expected.verdict === "suspicious",
        ).length,
        malicious: cases.filter((item) => item.expected.verdict === "malicious")
          .length,
      },
      by_tag: byTag,
    });
    return;
  }

  if (command === "eval-public") {
    if (!values.file)
      fail("Pass --file pointing at a JSONL set with text and label.");
    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      fail(
        "TYPESAFE_API_KEY is missing. Refusing to invent public-set scores.",
        2,
      );
    }
    const cases = await loadPublicCases(values.file);
    const report = await evaluatePublicSet({
      cases,
      client: createLiveJevClient(),
    });
    printResult(report);
    return;
  }

  if (command === "gandalf") {
    if (!resolveTypesafeApiKey()) {
      fail(
        "TYPESAFE_API_KEY is missing from the environment and from Claude/Cursor MCP config. Refusing to invent Gandalf scores.",
        2,
      );
    }
    const turns = await loadGandalf(
      values.file ?? resolve(root, "corpus/gandalf.jsonl"),
    );
    const report = await runGandalfPrecheck({
      turns,
      mode: "live",
      client: createLiveJevClient(),
    });
    const outDir = values.out ?? resolve(root, "eval/results");
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = resolve(outDir, `gandalf-live-${stamp}.json`);
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${formatGandalfReport(report)}\n`);
    process.stdout.write(`wrote ${outPath}\n`);
    return;
  }

  if (command === "eval") {
    const split = values.split;
    if (split !== "dev" && split !== "test" && split !== "all")
      fail("--split must be dev, test, or all.");
    const cases = await loadCorpus(
      values.corpus ?? resolve(root, "corpus/cases.jsonl"),
    );
    const selected = selectSplit(cases, split);
    const fixturePath = values.fixture;
    const hasKey = Boolean(process.env.TYPESAFE_API_KEY?.trim());
    if (!fixturePath && !hasKey) {
      fail(
        "TYPESAFE_API_KEY is missing and no --fixture file was given. Refusing to invent scores.",
        2,
      );
    }
    const mode = fixturePath ? "fixture" : "live";
    const report = await evaluateCorpus({
      cases,
      mode,
      split,
      ...(fixturePath
        ? { fixtures: await loadFixtures(fixturePath) }
        : { client: createLiveJevClient() }),
    });
    const output: {
      shield: typeof report;
      baseline?: unknown;
      canary?: unknown;
    } = { shield: report };
    if (values.baseline) {
      const model = selectBaseline();
      if (!model) {
        output.baseline = {
          skipped:
            "Set OPENAI_API_KEY or ANTHROPIC_API_KEY to run the cheap LLM judge.",
        };
      } else {
        output.baseline = await runBaseline({
          model,
          cases: selected.map((item) => ({
            id: item.id,
            content: item.content,
            source: item.source,
            expectedVerdict: item.expected.verdict,
            tags: item.tags,
          })),
        });
      }
    }
    if (values.canary) {
      const model = selectBaseline();
      if (!model) {
        output.canary = {
          skipped:
            "Set OPENAI_API_KEY or ANTHROPIC_API_KEY to run the canary harness.",
        };
      } else if (!hasKey) {
        output.canary = {
          skipped:
            "Canary protection needs TYPESAFE_API_KEY. Fixture files cover the labeled corpus, not the canary rows.",
        };
      } else {
        output.canary = await runCanary({
          cases: await loadCanary(resolve(root, "corpus/canary.jsonl")),
          model,
          client: createLiveJevClient(),
        });
      }
    }
    const outDir = values.out ?? resolve(root, "eval/results");
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = resolve(outDir, `${split}-${mode}-${stamp}.json`);
    await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${formatReport(report)}\n`);
    if (
      output.baseline &&
      typeof output.baseline === "object" &&
      "binary" in output.baseline
    ) {
      const baseline = output.baseline as {
        model: string;
        binary: { recall: number | null; false_positive_rate: number | null };
        cost_per_1000_usd: number | null;
      };
      process.stdout.write(
        `baseline ${baseline.model}: recall ${baseline.binary.recall ?? "n/a"} fpr ${baseline.binary.false_positive_rate ?? "n/a"} cost/1000 ${baseline.cost_per_1000_usd ?? "n/a"}\n`,
      );
    }
    process.stdout.write(`wrote ${outPath}\n`);
    return;
  }

  fail(`Unknown command ${command}. Run jev-shield help.`);
}

main().catch((error: unknown) => {
  if (isShieldError(error))
    fail(
      JSON.stringify({ error: { code: error.code, message: error.message } }),
    );
  const message = error instanceof Error ? error.message : "JEV Shield failed.";
  fail(message);
});
