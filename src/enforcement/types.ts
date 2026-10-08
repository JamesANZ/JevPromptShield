export const DECISIONS = ["ALLOW", "ASK", "BLOCK"] as const;

export type Decision = (typeof DECISIONS)[number];

export const ENV_CLASSES = ["dev", "staging", "production"] as const;

export type EnvClass = (typeof ENV_CLASSES)[number];

export const DECIDERS = ["local", "jev", "fallback"] as const;

export type Decider = (typeof DECIDERS)[number];

export const DISPOSITIONS = ["allow", "ask", "block"] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/** Signals an adapter may supply. Fields are optional because a host may omit them. */
export interface ActionContext {
  command: string;
  cwd?: string;
  gitBranch?: string;
  envClass?: EnvClass;
  tool: string;
  agent?: string;
  /** Agent-written note. Untrusted, and never treated as proof the command is safe. */
  description?: string;
}

/** Redacted record safe to send to Jev or write to the audit log. */
export interface ActionState {
  command: string;
  cwd: string | null;
  git_branch: string | null;
  environment: EnvClass | null;
  tool: string;
  agent: string | null;
  description: string | null;
}

export interface ActionJudgement {
  disposition: Disposition;
  confidence: number;
  irreversible: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface ActionClient {
  judge(state: ActionState): Promise<ActionJudgement>;
}

export interface ActionDecision {
  decision: Decision;
  decider: Decider;
  reason: string;
  jevCalled: boolean;
  command: string;
  latency_ms: number;
  model?: string;
  confidence?: number;
}
