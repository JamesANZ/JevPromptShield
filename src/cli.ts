#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.js";
import { createServer } from "./api/server.js";
import { isShieldError } from "./errors.js";
import { loadCorpus } from "./eval/corpus.js";
import { CORPUS_TAGS } from "./eval/corpus.js";
import { SOURCES, type Source } from "./types.js";
import { evaluateCorpus, formatReport, selectSplit } from "./eval/run.js";
import { loadCanary, runCanary } from "./eval/canary.js";
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
    if (!raw.id || !raw.decision) throw new Error("Each fixture line needs id and decision.");
    fixtures.set(raw.id, raw.decision);
  }
  return fixtures;
}

async function main(): Promise<void> {
  const { command, values } = await readFlags();
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`jev-shield analyze --source webpage --file page.txt
jev-shield analyze --source user --content "text"
jev-shield serve [--port 8787] [--host 127.0.0.1]
jev-shield corpus
jev-shield eval [--split test|dev|all] [--fixture scores.jsonl] [--baseline] [--canary]
jev-shield eval-public --file external.jsonl

Live eval needs TYPESAFE_API_KEY. Without a key or a fixture file, eval exits 2 and does not invent scores.
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

  if (command === "analyze") {
    let content = values.content;
    if (values.file) {
      const { readFile } = await import("node:fs/promises");
      content = await readFile(values.file, "utf8");
    }
    if (!content) fail("Pass --content or --file.");
    if (!values.source || !SOURCES.includes(values.source as Source)) {
      fail("Pass --source (user, webpage, pdf, email, rag, tool, mcp, agent, database, unknown).");
    }
    const source = values.source as Source;
    try {
      const result = await analyze({
        content,
        source,
        ...(values.context ? { context: values.context } : {}),
      });
      printResult(result);
    } catch (error) {
      if (isShieldError(error)) fail(JSON.stringify({ error: { code: error.code, message: error.message } }));
      throw error;
    }
    return;
  }

  if (command === "corpus") {
    const cases = await loadCorpus(values.corpus ?? resolve(root, "corpus/cases.jsonl"));
    const byTag = Object.fromEntries(CORPUS_TAGS.map((tag) => [tag, cases.filter((item) => item.tags.includes(tag)).length]));
    printResult({
      n: cases.length,
      dev: cases.filter((item) => splitForId(item.id) === "dev").length,
      test: cases.filter((item) => splitForId(item.id) === "test").length,
      by_verdict: {
        safe: cases.filter((item) => item.expected.verdict === "safe").length,
        suspicious: cases.filter((item) => item.expected.verdict === "suspicious").length,
        malicious: cases.filter((item) => item.expected.verdict === "malicious").length,
      },
      by_tag: byTag,
    });
    return;
  }

  if (command === "eval-public") {
    if (!values.file) fail("Pass --file pointing at a JSONL set with text and label.");
    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      fail("TYPESAFE_API_KEY is missing. Refusing to invent public-set scores.", 2);
    }
    const cases = await loadPublicCases(values.file);
    const report = await evaluatePublicSet({ cases, client: createLiveJevClient() });
    printResult(report);
    return;
  }

  if (command === "eval") {
    const split = values.split;
    if (split !== "dev" && split !== "test" && split !== "all") fail("--split must be dev, test, or all.");
    const cases = await loadCorpus(values.corpus ?? resolve(root, "corpus/cases.jsonl"));
    const selected = selectSplit(cases, split);
    const fixturePath = values.fixture;
    const hasKey = Boolean(process.env.TYPESAFE_API_KEY?.trim());
    if (!fixturePath && !hasKey) {
      fail("TYPESAFE_API_KEY is missing and no --fixture file was given. Refusing to invent scores.", 2);
    }
    const mode = fixturePath ? "fixture" : "live";
    const report = await evaluateCorpus({
      cases,
      mode,
      split,
      ...(fixturePath ? { fixtures: await loadFixtures(fixturePath) } : { client: createLiveJevClient() }),
    });
    const output: {
      shield: typeof report;
      baseline?: unknown;
      canary?: unknown;
    } = { shield: report };
    if (values.baseline) {
      const model = selectBaseline();
      if (!model) {
        output.baseline = { skipped: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY to run the cheap LLM judge." };
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
        output.canary = { skipped: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY to run the canary harness." };
      } else if (!hasKey) {
        output.canary = {
          skipped: "Canary protection needs TYPESAFE_API_KEY. Fixture files cover the labeled corpus, not the canary rows.",
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
    if (output.baseline && typeof output.baseline === "object" && "binary" in output.baseline) {
      const baseline = output.baseline as { model: string; binary: { recall: number | null; false_positive_rate: number | null }; cost_per_1000_usd: number | null };
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
  if (isShieldError(error)) fail(JSON.stringify({ error: { code: error.code, message: error.message } }));
  const message = error instanceof Error ? error.message : "JEV Shield failed.";
  fail(message);
});
