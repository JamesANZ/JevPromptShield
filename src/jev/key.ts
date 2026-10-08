import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveTypesafeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (env.JEV_SHIELD_DISABLE_KEY_DISCOVERY === "1") return undefined;
  for (const file of keyFiles(env)) {
    const key = keyFromConfigFile(file);
    if (key) return key;
  }
  return undefined;
}

function keyFiles(env: NodeJS.ProcessEnv): string[] {
  if (env.JEV_SHIELD_MCP_CONFIG) return [env.JEV_SHIELD_MCP_CONFIG];
  const home = env.HOME || homedir();
  return [
    join(home, ".cursor", "mcp.json"),
    join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
    join(home, ".claude.json"),
  ];
}

function keyFromConfigFile(path: string): string | undefined {
  try {
    return keyFromValue(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function keyFromValue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = keyFromValue(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const env = record.env;
  if (env !== null && typeof env === "object" && !Array.isArray(env)) {
    const key = (env as Record<string, unknown>).TYPESAFE_API_KEY;
    if (typeof key === "string" && key.trim() !== "") return key.trim();
  }
  for (const child of Object.values(record)) {
    const found = keyFromValue(child);
    if (found) return found;
  }
  return undefined;
}
