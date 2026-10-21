import type { EntryType } from "@typesafe-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { PINNED_MODEL } from "../config.js";
import { compareQuestions } from "../engine/compare.js";
import { ShieldError } from "../errors.js";
import { mapJevError } from "./client.js";
import { resolveTypesafeApiKey } from "./key.js";

export interface JudgedDocument {
  id: string;
  name: string;
  content: string;
}

export interface DocumentJudgement {
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** Yes-probabilities aligned with the documents passed to `judge`. */
  scores: number[];
}

export interface DocumentJudge {
  judge(input: {
    question: string;
    documents: JudgedDocument[];
  }): Promise<DocumentJudgement>;
}

function readNoul(
  value: { type: string; noul?: number } | undefined,
  name: string,
): number {
  if (
    !value ||
    value.type !== "noul" ||
    typeof value.noul !== "number" ||
    value.noul < 0 ||
    value.noul > 1
  ) {
    throw new ShieldError(
      "jev_error",
      `Jev returned an unusable answer for ${name}.`,
    );
  }
  return value.noul;
}

export function createLiveDocumentJudge(config?: {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): DocumentJudge {
  const apiKey = config?.apiKey ?? resolveTypesafeApiKey();
  let client: TypeSafeClient;
  try {
    client = new TypeSafeClient({
      ...(apiKey ? { apiKey } : {}),
      defaultModel: config?.model ?? PINNED_MODEL,
      logLevel: "off",
      ...(config?.timeoutMs
        ? { timeout: config.timeoutMs, retry: { maxRetries: 0 } }
        : {}),
    });
  } catch (error) {
    throw mapJevError(error);
  }
  const model = config?.model ?? PINNED_MODEL;

  return {
    async judge(input) {
      try {
        const result = await client.systemOne({
          model,
          state: {
            question: input.question,
            documents: input.documents.map((document) => ({
              id: document.id,
              name: document.name,
              content: document.content,
            })),
          } as unknown as EntryType,
          questions: compareQuestions(
            input.documents.map((document) => document.id),
          ),
        });
        if (
          !Number.isFinite(result.usage.input_tokens) ||
          result.usage.input_tokens < 0
        ) {
          throw new ShieldError(
            "jev_error",
            "Jev returned unusable token usage.",
          );
        }
        return {
          model: result.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          scores: input.documents.map((document) =>
            readNoul(result.answers[document.id], document.id),
          ),
        };
      } catch (error) {
        throw mapJevError(error);
      }
    },
  };
}
