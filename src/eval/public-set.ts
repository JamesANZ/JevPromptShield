import { readFile } from "node:fs/promises";
import { analyze } from "../analyze.js";
import {
  JEV_INPUT_USD_PER_MILLION,
  POLICY_VERSION,
  QUESTION_SET_VERSION,
  resolveThresholds,
} from "../config.js";
import { SOURCE_BLIND_SIGNAL } from "../engine/policy.js";
import type { JevClient } from "../jev/client.js";
import {
  CATEGORIES,
  SOURCES,
  type Category,
  type Source,
  type Verdict,
} from "../types.js";
import {
  buildEvalReport,
  type EvalReport,
  type ScoredCase,
} from "./metrics.js";

const WARNING =
  "External labels are not pooled into the hand-labeled confusion matrix. Some public sets mark ordinary tasks as injections.";

function asVerdict(label: unknown): Verdict | null {
  if (
    label === 1 ||
    label === "1" ||
    label === "malicious" ||
    label === "attack" ||
    label === "injection"
  ) {
    return "malicious";
  }
  if (label === 0 || label === "0" || label === "safe" || label === "benign")
    return "safe";
  return null;
}

export async function loadPublicCases(
  path: string,
): Promise<
  { id: string; content: string; source: Source; expectedVerdict: Verdict }[]
> {
  const text = await readFile(path, "utf8");
  const cases = [];
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (line.trim() === "") continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    const content = typeof raw.content === "string" ? raw.content : raw.text;
    const id = typeof raw.id === "string" ? raw.id : `line-${lineNumber}`;
    const verdict = asVerdict(raw.label);
    if (typeof content !== "string" || content.trim() === "" || !verdict) {
      throw new Error(
        `Public set line ${lineNumber} needs text and a safe or malicious label.`,
      );
    }
    const source =
      typeof raw.source === "string" && SOURCES.includes(raw.source as Source)
        ? (raw.source as Source)
        : "unknown";
    cases.push({ id, content, source, expectedVerdict: verdict });
  }
  return cases;
}

export async function evaluatePublicSet(input: {
  cases: {
    id: string;
    content: string;
    source: Source;
    expectedVerdict: Verdict;
  }[];
  client: JevClient;
}): Promise<EvalReport> {
  const thresholds = resolveThresholds();
  const rows: ScoredCase[] = [];
  const errors: string[] = [];
  for (const item of input.cases) {
    try {
      const result = await analyze(
        { content: item.content, source: item.source, thresholds },
        { client: input.client },
      );
      const triggered = CATEGORIES.filter(
        (category) => result.signals[category]?.triggered === true,
      );
      const blind = result.signals[SOURCE_BLIND_SIGNAL]?.score;
      rows.push({
        id: item.id,
        tags: [],
        expectedVerdict: item.expectedVerdict,
        expectedCategories: [],
        predictedVerdict: result.verdict,
        score: result.score,
        sourceBlindScore: typeof blind === "number" ? blind : 0,
        categoryUnionHit: triggered.length > 0,
        triggeredCategories: triggered as Category[],
        latencyMs: result.latency_ms,
        inputTokens: result.usage.input_tokens,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      errors.push(`${item.id}: ${message}`);
    }
  }
  return buildEvalReport({
    mode: "live",
    rows,
    errors,
    split: "all",
    thresholds,
    questionSetVersion: QUESTION_SET_VERSION,
    policyVersion: POLICY_VERSION,
    inputUsdPerMillion: JEV_INPUT_USD_PER_MILLION,
    tags: [],
    extraNotes: [WARNING],
  });
}
