import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createActionClient } from "../jev/action.js";
import { appendAudit, auditRecord } from "./audit.js";
import { classifyCommand } from "./classify.js";
import {
  MAX_DESCRIPTION_CHARS,
  resolveEnforcementConfig,
  type EnforcementConfig,
  type FailMode,
} from "./config.js";
import { decisionFromJudgement } from "./policy.js";
import { redactText } from "./redact.js";
import type {
  ActionClient,
  ActionContext,
  ActionDecision,
  ActionState,
  Decider,
  Decision,
} from "./types.js";

const execFileAsync = promisify(execFile);

export async function lookupGitBranch(
  cwd: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd,
        timeout: 500,
        encoding: "utf8",
      },
    );
    const branch = stdout.trim();
    if (
      branch === "" ||
      branch === "HEAD" ||
      branch.length > 200 ||
      /[\r\n]/.test(branch)
    )
      return undefined;
    return branch;
  } catch {
    return undefined;
  }
}

export interface EvaluateOptions {
  client?: ActionClient;
  config?: EnforcementConfig;
  env?: NodeJS.ProcessEnv;
  lookupBranch?: (cwd: string) => Promise<string | undefined>;
  createClient?: (config: EnforcementConfig) => ActionClient;
}

function fallback(failMode: FailMode): { decision: Decision; reason: string } {
  if (failMode === "block") {
    return {
      decision: "BLOCK",
      reason: "Jev was unavailable. Blocked because fail mode is block.",
    };
  }
  return {
    decision: "ASK",
    reason:
      "Jev was unavailable. Confirmation required before this command can run.",
  };
}

function toState(
  action: ActionContext,
  command: string,
  branch: string | undefined,
): ActionState {
  const description =
    action.description === undefined ||
    action.description.length > MAX_DESCRIPTION_CHARS
      ? null
      : redactText(action.description);
  return {
    command,
    cwd: action.cwd ?? null,
    git_branch: branch ?? null,
    environment: action.envClass ?? null,
    tool: action.tool,
    agent: action.agent ?? null,
    description,
  };
}

export async function evaluateAction(
  action: ActionContext,
  options: EvaluateOptions = {},
): Promise<ActionDecision> {
  const config = options.config ?? resolveEnforcementConfig(options.env);
  const started = performance.now();
  const branch =
    action.gitBranch ??
    (action.cwd
      ? await (options.lookupBranch ?? lookupGitBranch)(action.cwd)
      : undefined);
  const enriched: ActionContext = {
    ...action,
    ...(branch ? { gitBranch: branch } : {}),
    ...(action.envClass === undefined && config.envClass
      ? { envClass: config.envClass }
      : {}),
  };
  const redactedCommand = redactText(enriched.command);
  const local = classifyCommand(enriched.command, {
    ...(enriched.gitBranch ? { gitBranch: enriched.gitBranch } : {}),
    ...(enriched.description ? { description: enriched.description } : {}),
  });

  const finish = async (
    decision: Decision,
    decider: Decider,
    reason: string,
    jevCalled: boolean,
    extra?: { model?: string; confidence?: number },
  ): Promise<ActionDecision> => {
    const result: ActionDecision = {
      decision,
      decider,
      reason,
      jevCalled,
      command: redactedCommand,
      latency_ms: performance.now() - started,
      ...(extra?.model ? { model: extra.model } : {}),
      ...(extra?.confidence !== undefined
        ? { confidence: extra.confidence }
        : {}),
    };
    try {
      await appendAudit(
        config.auditPath,
        auditRecord({
          decision: result,
          tool: enriched.tool,
          ...(enriched.cwd ? { cwd: enriched.cwd } : {}),
          ...(enriched.gitBranch ? { branch: enriched.gitBranch } : {}),
          ...(enriched.agent ? { agent: enriched.agent } : {}),
        }),
      );
    } catch {
      // A log failure must not change the decision or escape as a non-zero hook exit.
    }
    return result;
  };

  if (local.outcome === "allow" || local.outcome === "block") {
    return finish(
      local.outcome === "allow" ? "ALLOW" : "BLOCK",
      "local",
      local.reason,
      false,
    );
  }

  const state = toState(enriched, redactedCommand, enriched.gitBranch);
  try {
    const client =
      options.client ??
      (options.createClient
        ? options.createClient(config)
        : createActionClient({ timeoutMs: config.jevTimeoutMs }));
    const judgement = await client.judge(state);
    const choice = decisionFromJudgement(judgement);
    return finish(choice.decision, "jev", choice.reason, true, {
      model: judgement.model,
      confidence: judgement.confidence,
    });
  } catch {
    const failed = fallback(config.failMode);
    return finish(failed.decision, "fallback", failed.reason, true);
  }
}
