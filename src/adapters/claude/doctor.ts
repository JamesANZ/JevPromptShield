import { execFile } from "node:child_process";
import { access, open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { claudeHookInstalled, promptHookInstalled } from "./install.js";
import { resolveEnforcementConfig } from "../../enforcement/config.js";
import { resolveTypesafeApiKey } from "../../jev/key.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function commandVersion(
  command: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["--version"],
      { timeout: 1500, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const line = stdout.trim().split("\n")[0];
        resolve(line === "" ? undefined : line);
      },
    );
  });
}

export async function runDoctor(options: {
  settingsPath: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  cliPath: string;
  claudeVersion?: string | undefined;
}): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const env = options.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  checks.push(
    Number.isInteger(major) && major >= 20
      ? { name: "node", status: "ok", detail: nodeVersion }
      : {
          name: "node",
          status: "fail",
          detail: `${nodeVersion} is older than Node 20`,
        },
  );

  try {
    await access(options.cliPath);
    checks.push({ name: "cli", status: "ok", detail: options.cliPath });
  } catch {
    checks.push({
      name: "cli",
      status: "fail",
      detail: `${options.cliPath} is missing. Build the project first.`,
    });
  }

  checks.push(
    resolveTypesafeApiKey(env)
      ? {
          name: "api_key",
          status: "ok",
          detail: "TYPESAFE_API_KEY is available",
        }
      : {
          name: "api_key",
          status: "fail",
          detail:
            "TYPESAFE_API_KEY was not found in the environment or in Claude/Cursor MCP config.",
        },
  );

  try {
    const text = await readFile(options.settingsPath, "utf8");
    const settings = JSON.parse(text) as unknown;
    checks.push(
      claudeHookInstalled(settings)
        ? { name: "hook", status: "ok", detail: options.settingsPath }
        : {
            name: "hook",
            status: "fail",
            detail: `No jev-shield hook in ${options.settingsPath}`,
          },
    );
    checks.push(
      promptHookInstalled(settings)
        ? { name: "prompt", status: "ok", detail: options.settingsPath }
        : {
            name: "prompt",
            status: "fail",
            detail: `No jev-shield prompt hook in ${options.settingsPath}`,
          },
    );
  } catch {
    checks.push({
      name: "hook",
      status: "fail",
      detail: `No readable Claude settings at ${options.settingsPath}. Run jev-shield setup claude.`,
    });
  }

  try {
    const config = resolveEnforcementConfig(env);
    await mkdir(dirname(config.auditPath), { recursive: true });
    const handle = await open(config.auditPath, "a", 0o600);
    await handle.close();
    checks.push({ name: "audit", status: "ok", detail: config.auditPath });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Audit path is not writable.";
    checks.push({ name: "audit", status: "fail", detail: message });
  }

  if (options.claudeVersion) {
    checks.push({
      name: "claude",
      status: "ok",
      detail: options.claudeVersion,
    });
  } else {
    checks.push({
      name: "claude",
      status: "warn",
      detail:
        "claude was not on PATH. Ask enforcement depends on Claude Code 2.1.211 or newer.",
    });
  }

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return `${checks.map((check) => `${check.name}: ${check.status} (${check.detail})`).join("\n")}\n`;
}
