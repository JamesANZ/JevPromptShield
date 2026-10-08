import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionDecision } from "./types.js";

export interface AuditRecord {
  timestamp: string;
  decision: ActionDecision["decision"];
  decider: ActionDecision["decider"];
  tool: string;
  command: string;
  cwd?: string;
  branch?: string;
  agent?: string;
  latency_ms: number;
  reason: string;
  model?: string;
}

export function auditRecord(input: {
  decision: ActionDecision;
  tool: string;
  cwd?: string;
  branch?: string;
  agent?: string;
  timestamp?: string;
}): AuditRecord {
  const record: AuditRecord = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    decision: input.decision.decision,
    decider: input.decision.decider,
    tool: input.tool,
    command: input.decision.command,
    latency_ms: input.decision.latency_ms,
    reason: input.decision.reason,
  };
  if (input.cwd !== undefined) record.cwd = input.cwd;
  if (input.branch !== undefined) record.branch = input.branch;
  if (input.agent !== undefined) record.agent = input.agent;
  if (input.decision.model !== undefined) record.model = input.decision.model;
  return record;
}

export async function appendAudit(
  path: string,
  record: AuditRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
