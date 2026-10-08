import type { ActionJudgement, Decision } from "./types.js";

/** Below this, a Jev allow or block becomes ASK. */
export const CONFIDENCE_FLOOR = 0.7;

export interface PolicyChoice {
  decision: Decision;
  reason: string;
}

export function decisionFromJudgement(
  judgement: ActionJudgement,
): PolicyChoice {
  if (judgement.irreversible >= 0.75) {
    return {
      decision: "BLOCK",
      reason: "Jev rated the command as likely irreversible harm.",
    };
  }
  if (judgement.disposition === "block") {
    if (judgement.confidence >= CONFIDENCE_FLOOR) {
      return { decision: "BLOCK", reason: "Jev blocked the command." };
    }
    return {
      decision: "ASK",
      reason: "Jev leaned toward block with low confidence.",
    };
  }
  if (judgement.disposition === "ask" || judgement.irreversible >= 0.4) {
    return {
      decision: "ASK",
      reason: "Jev asked for confirmation before the command runs.",
    };
  }
  if (judgement.confidence >= CONFIDENCE_FLOOR) {
    return { decision: "ALLOW", reason: "Jev allowed the command." };
  }
  return {
    decision: "ASK",
    reason: "Jev leaned toward allow with low confidence.",
  };
}
