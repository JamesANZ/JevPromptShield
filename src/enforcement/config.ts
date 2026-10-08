import { homedir } from "node:os";
import { join } from "node:path";
import { ShieldError } from "../errors.js";
import { ENV_CLASSES, type EnvClass } from "./types.js";

export const ACTION_POLICY_VERSION = "2026-10-08.1";
export const MAX_COMMAND_CHARS = 8_000;
export const MAX_DESCRIPTION_CHARS = 500;
export const DEFAULT_JEV_TIMEOUT_MS = 2_500;
export const DEFAULT_FAIL_MODE = "ask" as const;

export type FailMode = "ask" | "block";

export interface EnforcementConfig {
  failMode: FailMode;
  auditPath: string;
  envClass?: EnvClass;
  jevTimeoutMs: number;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function defaultAuditPath(): string {
  return join(homedir(), ".jev-shield", "audit.jsonl");
}

export function resolveEnforcementConfig(
  env: NodeJS.ProcessEnv = process.env,
): EnforcementConfig {
  const failRaw = env.JEV_SHIELD_FAIL_MODE?.trim().toLowerCase();
  let failMode: FailMode = DEFAULT_FAIL_MODE;
  if (failRaw !== undefined && failRaw !== "") {
    if (failRaw !== "ask" && failRaw !== "block") {
      throw new ShieldError(
        "invalid_request",
        "JEV_SHIELD_FAIL_MODE must be ask or block.",
      );
    }
    failMode = failRaw;
  }

  const envRaw = env.JEV_SHIELD_ENV_CLASS?.trim().toLowerCase();
  let envClass: EnvClass | undefined;
  if (envRaw !== undefined && envRaw !== "") {
    if (!ENV_CLASSES.includes(envRaw as EnvClass)) {
      throw new ShieldError(
        "invalid_request",
        "JEV_SHIELD_ENV_CLASS must be dev, staging, or production.",
      );
    }
    envClass = envRaw as EnvClass;
  }

  const timeoutRaw = env.JEV_SHIELD_JEV_TIMEOUT_MS?.trim();
  let jevTimeoutMs = DEFAULT_JEV_TIMEOUT_MS;
  if (timeoutRaw !== undefined && timeoutRaw !== "") {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed < 100 || parsed > 10_000) {
      throw new ShieldError(
        "invalid_request",
        "JEV_SHIELD_JEV_TIMEOUT_MS must be an integer from 100 to 10000.",
      );
    }
    jevTimeoutMs = parsed;
  }

  const auditRaw = env.JEV_SHIELD_AUDIT_LOG?.trim();
  const auditPath = auditRaw ? expandHome(auditRaw) : defaultAuditPath();

  return {
    failMode,
    auditPath,
    ...(envClass ? { envClass } : {}),
    jevTimeoutMs,
  };
}
