import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ShieldError, isShieldError } from "../../errors.js";

export const CLAUDE_HOOK_TIMEOUT_SEC = 15;
export const CLAUDE_PROMPT_HOOK_TIMEOUT_SEC = 20;

interface HookHandler {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: unknown[];
  [key: string]: unknown;
}

export function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function claudeHookCommand(nodePath: string, cliPath: string): string {
  return `${quoteShellArg(nodePath)} ${quoteShellArg(cliPath)} hook claude`;
}

export function claudePromptHookCommand(
  nodePath: string,
  cliPath: string,
): string {
  return `${quoteShellArg(nodePath)} ${quoteShellArg(cliPath)} hook prompt`;
}

function isOurs(handler: unknown): handler is HookHandler {
  if (handler === null || typeof handler !== "object") return false;
  const command = (handler as HookHandler).command;
  return typeof command === "string" && command.includes("hook claude");
}

function isPromptHook(handler: unknown): handler is HookHandler {
  if (handler === null || typeof handler !== "object") return false;
  const command = (handler as HookHandler).command;
  return typeof command === "string" && command.includes("hook prompt");
}

export function mergeClaudeHook(
  existing: unknown,
  command: string,
): { settings: Record<string, unknown>; changed: boolean } {
  if (
    existing === null ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    throw new ShieldError(
      "invalid_request",
      "Claude settings must be a JSON object.",
    );
  }
  const settings = structuredClone(existing) as Record<string, unknown>;
  const hooksRaw = settings.hooks;
  const hooks: Record<string, unknown> =
    hooksRaw !== null &&
    typeof hooksRaw === "object" &&
    !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)
      : {};
  settings.hooks = hooks;
  const pre: MatcherGroup[] = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as MatcherGroup[])
    : [];
  hooks.PreToolUse = pre;

  const handler: HookHandler = {
    type: "command",
    command,
    timeout: CLAUDE_HOOK_TIMEOUT_SEC,
  };

  let group = pre.find(
    (item) =>
      item &&
      typeof item === "object" &&
      item.matcher === "Bash" &&
      Array.isArray(item.hooks) &&
      item.hooks.some(isOurs),
  );
  if (!group) {
    group = pre.find(
      (item) => item && typeof item === "object" && item.matcher === "Bash",
    );
  }
  if (!group) {
    group = { matcher: "Bash", hooks: [] };
    pre.push(group);
  }
  if (!Array.isArray(group.hooks)) group.hooks = [];
  const index = group.hooks.findIndex(isOurs);
  if (index === -1) group.hooks.push(handler);
  else
    group.hooks[index] = { ...(group.hooks[index] as HookHandler), ...handler };

  return {
    settings,
    changed: JSON.stringify(existing) !== JSON.stringify(settings),
  };
}

export function mergePromptHook(
  existing: unknown,
  command: string,
): { settings: Record<string, unknown>; changed: boolean } {
  if (
    existing === null ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    throw new ShieldError(
      "invalid_request",
      "Claude settings must be a JSON object.",
    );
  }
  const settings = structuredClone(existing) as Record<string, unknown>;
  const hooksRaw = settings.hooks;
  const hooks: Record<string, unknown> =
    hooksRaw !== null &&
    typeof hooksRaw === "object" &&
    !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)
      : {};
  settings.hooks = hooks;
  const groups: MatcherGroup[] = Array.isArray(hooks.UserPromptSubmit)
    ? (hooks.UserPromptSubmit as MatcherGroup[])
    : [];
  hooks.UserPromptSubmit = groups;

  const handler: HookHandler = {
    type: "command",
    command,
    timeout: CLAUDE_PROMPT_HOOK_TIMEOUT_SEC,
  };
  let group = groups.find(
    (item) =>
      item &&
      typeof item === "object" &&
      Array.isArray(item.hooks) &&
      item.hooks.some(isPromptHook),
  );
  if (!group) {
    group = { hooks: [] };
    groups.push(group);
  }
  if (!Array.isArray(group.hooks)) group.hooks = [];
  const index = group.hooks.findIndex(isPromptHook);
  if (index === -1) group.hooks.push(handler);
  else
    group.hooks[index] = { ...(group.hooks[index] as HookHandler), ...handler };

  return {
    settings,
    changed: JSON.stringify(existing) !== JSON.stringify(settings),
  };
}

export function promptHookInstalled(settings: unknown): boolean {
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  )
    return false;
  const hooks = (settings as { hooks?: { UserPromptSubmit?: unknown } }).hooks;
  if (!hooks || !Array.isArray(hooks.UserPromptSubmit)) return false;
  return hooks.UserPromptSubmit.some(
    (group) =>
      group !== null &&
      typeof group === "object" &&
      Array.isArray((group as MatcherGroup).hooks) &&
      (group as MatcherGroup).hooks?.some(isPromptHook) === true,
  );
}

export function claudeHookInstalled(settings: unknown): boolean {
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  )
    return false;
  const hooks = (settings as { hooks?: { PreToolUse?: unknown } }).hooks;
  if (!hooks || !Array.isArray(hooks.PreToolUse)) return false;
  return hooks.PreToolUse.some(
    (group) =>
      group !== null &&
      typeof group === "object" &&
      Array.isArray((group as MatcherGroup).hooks) &&
      (group as MatcherGroup).hooks?.some(isOurs) === true,
  );
}

async function readSettings(settingsPath: string): Promise<unknown> {
  try {
    const text = await readFile(settingsPath, "utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ShieldError(
        "invalid_request",
        `Refusing to overwrite invalid JSON in ${settingsPath}.`,
      );
    }
  } catch (error) {
    if (isShieldError(error)) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

async function writeSettings(
  settingsPath: string,
  merged: { settings: Record<string, unknown>; changed: boolean },
): Promise<{ changed: boolean }> {
  if (!merged.changed) return { changed: false };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    `${JSON.stringify(merged.settings, null, 2)}\n`,
  );
  return { changed: true };
}

export async function installClaudeHook(
  settingsPath: string,
  command: string,
): Promise<{ changed: boolean }> {
  return writeSettings(
    settingsPath,
    mergeClaudeHook(await readSettings(settingsPath), command),
  );
}

export async function installPromptHook(
  settingsPath: string,
  command: string,
): Promise<{ changed: boolean }> {
  return writeSettings(
    settingsPath,
    mergePromptHook(await readSettings(settingsPath), command),
  );
}
