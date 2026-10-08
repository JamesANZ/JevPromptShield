import { ShieldError } from "./errors.js";
import type { Thresholds } from "./types.js";

export const QUESTION_SET_VERSION = "2026-10-01.1";
export const POLICY_VERSION = "2026-10-01.1";
export const PINNED_MODEL = "jev-1.13.0";

/** Published TypeSafe direct-API input price for Jev 1.13. Output tokens are free. */
export const JEV_INPUT_USD_PER_MILLION = 0.042;

/**
 * Conservative character cap so state plus the question checklist stays inside
 * Jev's smaller budget (about 32k tokens for state plus the longest question).
 * Oversize content is rejected. Shield does not truncate.
 */
export const MAX_CONTENT_CHARS = 100_000;
export const MAX_CONTEXT_CHARS = 2_000;

export const DEFAULT_THRESHOLDS: Thresholds = {
  suspicious: 0.4,
  malicious: 0.75,
};

export function estimateJevCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MILLION;
}

function readUnitInterval(
  name: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ShieldError(
      "invalid_request",
      `${name} must be a number from 0 to 1.`,
    );
  }
  return value;
}

export function assertThresholds(thresholds: Thresholds): void {
  for (const [name, value] of [
    ["suspicious", thresholds.suspicious],
    ["malicious", thresholds.malicious],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new ShieldError(
        "invalid_request",
        `${name} threshold must be a number from 0 to 1.`,
      );
    }
  }
  if (thresholds.suspicious >= thresholds.malicious) {
    throw new ShieldError(
      "invalid_request",
      "suspicious threshold must be below the malicious threshold.",
    );
  }
}

export function resolveThresholds(
  override?: Partial<Thresholds>,
  env: NodeJS.ProcessEnv = process.env,
): Thresholds {
  const suspicious =
    override?.suspicious ??
    readUnitInterval(
      "JEV_SHIELD_SUSPICIOUS_THRESHOLD",
      env.JEV_SHIELD_SUSPICIOUS_THRESHOLD,
    ) ??
    DEFAULT_THRESHOLDS.suspicious;
  const malicious =
    override?.malicious ??
    readUnitInterval(
      "JEV_SHIELD_MALICIOUS_THRESHOLD",
      env.JEV_SHIELD_MALICIOUS_THRESHOLD,
    ) ??
    DEFAULT_THRESHOLDS.malicious;
  const thresholds = { suspicious, malicious };
  assertThresholds(thresholds);
  return thresholds;
}
