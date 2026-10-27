import { execFile } from "node:child_process";
import { access, open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  claudeHookInstalled,
  contentHooksInstalled,
  promptHookInstalled,
} from "./install.js";
import { resolveEnforcementConfig } from "../../enforcement/config.js";
import { resolveTypesafeApiKey } from "../../jev/key.js";
import { createLiveJevClient } from "../../jev/client.js";
import {
  createOpenAiMediaTranscriber,
  prepareMedia,
} from "../../media/transcribe.js";

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
  live?: boolean;
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

  const openAiKey = env.OPENAI_API_KEY?.trim() ?? "";
  checks.push(
    openAiKey
      ? {
          name: "media_key",
          status: "ok",
          detail: "OPENAI_API_KEY is available for media and the OpenAI proxy",
        }
      : {
          name: "media_key",
          status: "warn",
          detail: "OPENAI_API_KEY is unset; text scanning works, but media and the OpenAI proxy are unavailable",
        },
  );
  try {
    createOpenAiMediaTranscriber({ env });
    const timeout = env.JEV_SHIELD_TRANSCRIBE_TIMEOUT_MS?.trim() || "30000";
    checks.push({
      name: "media_config",
      status: "ok",
      detail: `vision=${env.JEV_SHIELD_VISION_MODEL?.trim() || "gpt-4o-mini"}, speech=${env.JEV_SHIELD_TRANSCRIBE_MODEL?.trim() || "whisper-1"}, timeout_ms=${timeout}`,
    });
  } catch (error) {
    checks.push({
      name: "media_config",
      status: "fail",
      detail: error instanceof Error ? error.message : "Invalid media configuration",
    });
  }
  try {
    const upstream = new URL(env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1");
    if (upstream.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(upstream.hostname)) {
      throw new Error("OPENAI_BASE_URL must use HTTPS, except on loopback.");
    }
    const rawTimeout = env.JEV_SHIELD_PROXY_SCAN_TIMEOUT_MS?.trim();
    const timeout = rawTimeout ? Number(rawTimeout) : 20_000;
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
      throw new Error("JEV_SHIELD_PROXY_SCAN_TIMEOUT_MS must be from 1000 to 120000.");
    }
    checks.push({ name: "proxy_config", status: "ok", detail: `${upstream.origin}, scan_timeout_ms=${timeout}` });
  } catch (error) {
    checks.push({
      name: "proxy_config",
      status: "fail",
      detail: error instanceof Error ? error.message : "Invalid proxy configuration",
    });
  }

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
    checks.push(
      contentHooksInstalled(settings)
        ? { name: "tool_content", status: "ok", detail: options.settingsPath }
        : {
            name: "tool_content",
            status: "fail",
            detail: `No jev-shield tool-content hooks in ${options.settingsPath}`,
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

  if (options.live) {
    try {
      await createLiveJevClient({
        apiKey: resolveTypesafeApiKey(env),
        timeoutMs: 8_000,
      }).decide({ content: "What is 2 + 2?", source: "user" });
      checks.push({ name: "live_jev", status: "ok", detail: "TypeSafe scoring request succeeded" });
    } catch (error) {
      checks.push({
        name: "live_jev",
        status: "fail",
        detail: error instanceof Error ? error.message : "Live TypeSafe request failed",
      });
    }
    if (openAiKey) {
      try {
        const transcriber = createOpenAiMediaTranscriber({ env });
        const image = prepareMedia("image", {
          media_type: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        });
        const wav = Buffer.alloc(64);
        wav.write("RIFF", 0);
        wav.writeUInt32LE(56, 4);
        wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(10_000, 24);
        wav.writeUInt32LE(20_000, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36);
        wav.writeUInt32LE(20, 40);
        const audio = prepareMedia("audio", { media_type: "audio/wav", data: wav });
        await transcriber.transcribeImage(image);
        await transcriber.transcribeAudio(audio);
        checks.push({ name: "live_media", status: "ok", detail: "OpenAI OCR and speech requests succeeded" });
      } catch (error) {
        checks.push({
          name: "live_media",
          status: "fail",
          detail: error instanceof Error ? error.message : "Live media request failed",
        });
      }
    } else {
      checks.push({ name: "live_media", status: "warn", detail: "Skipped because OPENAI_API_KEY is unset" });
    }
  }

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return `${checks.map((check) => `${check.name}: ${check.status} (${check.detail})`).join("\n")}\n`;
}
