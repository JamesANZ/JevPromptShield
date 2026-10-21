import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compareDocuments } from "../src/compare.js";
import { MAX_CONTENT_CHARS } from "../src/config.js";
import {
  COMPARE_INSTRUCTIONS,
  compareQuestions,
} from "../src/engine/compare.js";
import { ShieldError } from "../src/errors.js";
import type { DocumentJudge } from "../src/jev/documents.js";
import type { MediaTranscriber } from "../src/media/transcribe.js";

function judge(
  scores: number[],
  seen: { question: string; ids: string[] }[] = [],
): DocumentJudge {
  return {
    async judge(input) {
      seen.push({
        question: input.question,
        ids: input.documents.map((document) => document.id),
      });
      return {
        model: "fixture",
        input_tokens: 40,
        output_tokens: 4,
        scores,
      };
    },
  };
}

const transcriber: MediaTranscriber = {
  async transcribeImage() {
    return "Gerald signed the clinic intake form.";
  },
  async transcribeAudio() {
    return "This recording is about annual health checks.";
  },
};

describe("compare documents", () => {
  it("returns every matching document, highest score first", async () => {
    const seen: { question: string; ids: string[] }[] = [];
    const result = await compareDocuments(
      {
        question: "Which document mentions Gerald?",
        documents: [
          { name: "clinic.txt", content: "The clinic sent a reminder." },
          { name: "notes.txt", content: "Gerald joined the meeting." },
          { id: "voice", name: "memo.wav", content: "No names here." },
        ],
      },
      { judge: judge([0.61, 0.94, 0.1], seen) },
    );
    assert.deepEqual(
      result.matches.map((match) => match.name),
      ["notes.txt", "clinic.txt"],
    );
    assert.deepEqual(
      result.documents.map((document) => document.id),
      ["document_1", "document_2", "voice"],
    );
    assert.equal(result.documents[2]?.matches, false);
    assert.equal(result.threshold, 0.5);
    assert.equal(result.question_set_version, "2026-10-20.1");
    assert.deepEqual(seen, [
      {
        question: "Which document mentions Gerald?",
        ids: ["document_1", "document_2", "voice"],
      },
    ]);
  });

  it("reads an image and a recording before asking which document matches", async () => {
    let contents: string[] = [];
    const result = await compareDocuments(
      {
        question: "Which document is about health?",
        documents: [
          {
            name: "page.png",
            image: { media_type: "image/png", data: "AAAA" },
          },
          {
            name: "memo.mp3",
            audio: { media_type: "audio/mpeg", data: new Uint8Array([1, 2]) },
          },
        ],
      },
      {
        transcriber,
        judge: {
          async judge(input) {
            contents = input.documents.map((document) => document.content);
            return {
              model: "fixture",
              input_tokens: 20,
              output_tokens: 2,
              scores: [0.2, 0.88],
            };
          },
        },
      },
    );
    assert.deepEqual(contents, [
      "Gerald signed the clinic intake form.",
      "This recording is about annual health checks.",
    ]);
    assert.equal(result.matches[0]?.name, "memo.mp3");
    assert.equal(
      result.documents[0]?.transcript,
      "Gerald signed the clinic intake form.",
    );
    assert.equal(result.documents[1]?.matches, true);
  });

  it("rejects a single document and an empty question before judging", async () => {
    let called = false;
    const probe: DocumentJudge = {
      async judge() {
        called = true;
        return {
          model: "fixture",
          input_tokens: 1,
          output_tokens: 1,
          scores: [],
        };
      },
    };
    await assert.rejects(
      () =>
        compareDocuments(
          {
            question: "Which document mentions Gerald?",
            documents: [{ content: "Gerald" }],
          },
          { judge: probe },
        ),
      /2 to 8/,
    );
    await assert.rejects(
      () =>
        compareDocuments(
          { question: "   ", documents: [{ content: "a" }, { content: "b" }] },
          { judge: probe },
        ),
      /question/,
    );
    assert.equal(called, false);
  });

  it("rejects combined text that exceeds the Jev budget before judging", async () => {
    let called = false;
    const probe: DocumentJudge = {
      async judge() {
        called = true;
        return {
          model: "fixture",
          input_tokens: 1,
          output_tokens: 1,
          scores: [0, 0],
        };
      },
    };
    const half = "x".repeat(Math.floor(MAX_CONTENT_CHARS / 2) + 10);
    await assert.rejects(
      () =>
        compareDocuments(
          {
            question: "Which document is about health?",
            documents: [{ content: half }, { content: half }],
          },
          { judge: probe },
        ),
      (error: unknown) =>
        error instanceof ShieldError && error.code === "oversize",
    );
    assert.equal(called, false);
  });

  it("keeps the caller question out of the question instructions", () => {
    const questions = compareQuestions(["document_1", "document_2"]);
    assert.deepEqual(Object.keys(questions), ["document_1", "document_2"]);
    assert.equal(questions.document_1?.type, "noul");
    assert.equal(questions.document_1?.instructions, COMPARE_INSTRUCTIONS);
    assert.doesNotMatch(COMPARE_INSTRUCTIONS, /Gerald/);
    assert.match(COMPARE_INSTRUCTIONS, /state\.question/);
  });
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return once(child, "exit").then(([code]) => ({
    code: code as number | null,
    stdout,
    stderr,
  }));
}

describe("compare cli", () => {
  it("requires a question and at least two documents", async () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    env.JEV_SHIELD_DISABLE_KEY_DISCOVERY = "1";
    const missingQuestion = await runCli(["compare", "a.txt", "b.txt"], env);
    assert.equal(missingQuestion.code, 1);
    assert.match(missingQuestion.stderr, /--question/);
    const oneFile = await runCli(
      ["compare", "--question", "Which document mentions Gerald?", "notes.txt"],
      env,
    );
    assert.equal(oneFile.code, 1);
    assert.match(oneFile.stderr, /at least two/);
  });

  it("refuses to invent a comparison when the API key is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-compare-"));
    const notes = join(dir, "notes.txt");
    const clinic = join(dir, "clinic.txt");
    await writeFile(notes, "Gerald joined the meeting.\n");
    await writeFile(clinic, "The clinic covers annual checkups.\n");
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    env.JEV_SHIELD_DISABLE_KEY_DISCOVERY = "1";
    const result = await runCli(
      [
        "compare",
        "--question",
        "Which document mentions Gerald?",
        notes,
        clinic,
      ],
      env,
    );
    assert.equal(result.code, 1);
    const body = JSON.parse(result.stderr) as { error: { code: string } };
    assert.equal(body.error.code, "jev_auth");
  });
});
