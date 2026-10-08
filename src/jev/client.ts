import type { EntryType } from "@typesafe-ai/sdk";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import { PINNED_MODEL } from "../config.js";
import { ShieldError } from "../errors.js";
import { resolveTypesafeApiKey } from "./key.js";
import { type JevDecision, SOURCE_BLIND_SIGNAL } from "../engine/policy.js";
import { SHIELD_QUESTIONS, buildState } from "../engine/questions.js";
import {
  CATEGORIES,
  CONTENT_ROLES,
  type ContentRole,
  type Source,
} from "../types.js";

export interface JevClient {
  decide(input: {
    content: string;
    source: Source;
    context?: string;
  }): Promise<JevDecision>;
}

export function mapJevError(error: unknown): ShieldError {
  if (error instanceof ShieldError) return error;
  if (
    error instanceof AuthenticationError ||
    (error instanceof TypeSafeError && /api key/i.test(error.message))
  ) {
    return new ShieldError(
      "jev_auth",
      "Jev rejected the API key or TYPESAFE_API_KEY is missing.",
      { cause: error },
    );
  }
  if (error instanceof RateLimitError) {
    return new ShieldError("jev_rate_limit", "Jev rate limit exceeded.", {
      cause: error,
    });
  }
  if (error instanceof APITimeoutError) {
    return new ShieldError("jev_unavailable", "Jev request timed out.", {
      cause: error,
    });
  }
  if (error instanceof APIConnectionError) {
    return new ShieldError("jev_unavailable", "Jev could not be reached.", {
      cause: error,
    });
  }
  if (error instanceof APIError) {
    if (error.status === 402) {
      return new ShieldError(
        "jev_payment",
        "Jev account has insufficient credits.",
        { cause: error },
      );
    }
    if (error.status >= 500) {
      return new ShieldError(
        "jev_unavailable",
        "Jev returned a server error.",
        { cause: error },
      );
    }
    const body =
      typeof error.body === "string"
        ? error.body
        : JSON.stringify(error.body ?? "");
    if (/max_tokens|too long|context length/i.test(body)) {
      return new ShieldError(
        "oversize",
        "Jev rejected the request as too long. Shield does not truncate.",
        {
          cause: error,
        },
      );
    }
    return new ShieldError(
      "jev_error",
      `Jev rejected the request (${error.status}).`,
      { cause: error },
    );
  }
  if (error instanceof Error)
    return new ShieldError("jev_error", error.message, { cause: error });
  return new ShieldError("jev_error", "Jev request failed.");
}

function readNoul(
  value: { type: string; noul?: number },
  name: string,
): number {
  if (
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

export function createLiveJevClient(config?: {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): JevClient {
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
    async decide(input) {
      try {
        const result = await client.systemOne({
          model,
          state: buildState(input) as unknown as EntryType,
          questions: SHIELD_QUESTIONS,
        });
        const scores = {} as JevDecision["scores"];
        for (const category of CATEGORIES) {
          scores[category] = readNoul(result.answers[category], category);
        }
        scores[SOURCE_BLIND_SIGNAL] = readNoul(
          result.answers.prompt_injection_source_blind,
          SOURCE_BLIND_SIGNAL,
        );

        const role = result.answers.content_role;
        if (
          role.type !== "choice" ||
          !CONTENT_ROLES.includes(role.choice as ContentRole)
        ) {
          throw new ShieldError(
            "jev_error",
            "Jev returned an unknown content role.",
          );
        }
        const contentRole = role.choice as ContentRole;
        const probability = role.probabilities[contentRole];
        if (typeof probability !== "number") {
          throw new ShieldError(
            "jev_error",
            "Jev returned an unusable content-role probability.",
          );
        }
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
          scores,
          content_role: contentRole,
          content_role_probability: probability,
        };
      } catch (error) {
        throw mapJevError(error);
      }
    },
  };
}

export function emptyScores(primary = 0): JevDecision["scores"] {
  const scores = {} as JevDecision["scores"];
  for (const category of CATEGORIES) scores[category] = 0;
  scores.prompt_injection = primary;
  scores[SOURCE_BLIND_SIGNAL] = 0;
  return scores;
}

/** Used by tests. A thrown client error must not be converted into a safe result. */
export function decisionFromScores(
  scores: Partial<JevDecision["scores"]>,
  extras?: Partial<
    Pick<
      JevDecision,
      "content_role" | "content_role_probability" | "model" | "input_tokens"
    >
  >,
): JevDecision {
  return {
    model: extras?.model ?? "fixture",
    input_tokens: extras?.input_tokens ?? 100,
    output_tokens: 10,
    scores: { ...emptyScores(), ...scores },
    content_role: extras?.content_role ?? "data",
    content_role_probability: extras?.content_role_probability ?? 0.9,
  };
}
