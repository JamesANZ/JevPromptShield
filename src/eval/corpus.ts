import { readFile } from "node:fs/promises";
import { ShieldError } from "../errors.js";
import {
  CATEGORIES,
  SOURCES,
  VERDICTS,
  type Category,
  type Source,
  type Verdict,
} from "../types.js";

export const CORPUS_TAGS = [
  "benign_data",
  "user_task",
  "obvious",
  "subtle",
  "indirect",
  "obfuscated",
  "encoded",
  "multilingual",
  "embedded",
  "hard_negative",
] as const;

export type CorpusTag = (typeof CORPUS_TAGS)[number];

export interface CorpusCase {
  id: string;
  content: string;
  source: Source;
  expected: {
    verdict: Verdict;
    categories: Category[];
  };
  tags: CorpusTag[];
  notes?: string;
  context?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCorpusCase(raw: unknown, line: number): CorpusCase {
  if (!isRecord(raw))
    throw new ShieldError(
      "invalid_request",
      `Corpus line ${line} is not an object.`,
    );
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    throw new ShieldError(
      "invalid_request",
      `Corpus line ${line} is missing id.`,
    );
  }
  if (typeof raw.content !== "string" || raw.content.trim() === "") {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} has empty content.`,
    );
  }
  if (
    typeof raw.source !== "string" ||
    !SOURCES.includes(raw.source as Source)
  ) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} has an unknown source.`,
    );
  }
  if (!isRecord(raw.expected)) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} is missing expected.`,
    );
  }
  const verdict = raw.expected.verdict;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict as Verdict)) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} has an unknown verdict.`,
    );
  }
  if (
    !Array.isArray(raw.expected.categories) ||
    !raw.expected.categories.every((item) => typeof item === "string")
  ) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} has invalid categories.`,
    );
  }
  const categories = raw.expected.categories as string[];
  if (categories.some((item) => !CATEGORIES.includes(item as Category))) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} has an unknown category.`,
    );
  }
  if (verdict === "safe" && categories.length > 0) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} is safe and also lists categories.`,
    );
  }
  if (verdict !== "safe" && categories.length === 0) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} is ${verdict} and lists no categories.`,
    );
  }
  if (
    !Array.isArray(raw.tags) ||
    raw.tags.length === 0 ||
    raw.tags.some((tag) => typeof tag !== "string")
  ) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} needs at least one tag.`,
    );
  }
  if (raw.tags.some((tag) => !CORPUS_TAGS.includes(tag as CorpusTag))) {
    throw new ShieldError(
      "invalid_request",
      `Corpus case ${raw.id} has an unknown tag.`,
    );
  }
  const parsed: CorpusCase = {
    id: raw.id,
    content: raw.content,
    source: raw.source as Source,
    expected: {
      verdict: verdict as Verdict,
      categories: categories as Category[],
    },
    tags: raw.tags as CorpusTag[],
  };
  if (typeof raw.notes === "string") parsed.notes = raw.notes;
  if (typeof raw.context === "string") parsed.context = raw.context;
  return parsed;
}

export function parseCorpus(text: string): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  let lineNumber = 0;
  for (const line of lines) {
    lineNumber += 1;
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new ShieldError(
        "invalid_request",
        `Corpus line ${lineNumber} is not valid JSON.`,
      );
    }
    const item = parseCorpusCase(raw, lineNumber);
    if (seen.has(item.id))
      throw new ShieldError(
        "invalid_request",
        `Duplicate corpus id ${item.id}.`,
      );
    seen.add(item.id);
    cases.push(item);
  }
  return cases;
}

export async function loadCorpus(path: string): Promise<CorpusCase[]> {
  const text = await readFile(path, "utf8");
  return parseCorpus(text);
}
