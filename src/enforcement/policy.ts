import type { ActionJudgement, Decision } from "./types.js";

/** Below this, a Jev allow or block becomes ASK. */
export const CONFIDENCE_FLOOR = 0.7;

export interface PolicyChoice {
  decision: Decision;
  reason: string;
}

function allowPhase(judgement: ActionJudgement): PolicyChoice {
  if (judgement.irreversible >= 0.4) {
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

/**
 * One transition from a Jev judgement to ALLOW, ASK, or BLOCK.
 * Irreversible harm at 0.75 or more blocks before the disposition is trusted.
 * A block disposition, an ask disposition, and an allow disposition do not overlap.
 */
export function decisionFromJudgement(
  judgement: ActionJudgement,
): PolicyChoice {
  if (judgement.irreversible >= 0.75) {
    return {
      decision: "BLOCK",
      reason: "Jev rated the command as likely irreversible harm.",
    };
  }
  switch (judgement.disposition) {
    case "block":
      if (judgement.confidence >= CONFIDENCE_FLOOR) {
        return { decision: "BLOCK", reason: "Jev blocked the command." };
      }
      return {
        decision: "ASK",
        reason: "Jev leaned toward block with low confidence.",
      };
    case "ask":
      return {
        decision: "ASK",
        reason: "Jev asked for confirmation before the command runs.",
      };
    case "allow":
      return allowPhase(judgement);
    default: {
      const unexpected: never = judgement.disposition;
      throw new Error(`Unexpected action disposition ${String(unexpected)}.`);
    }
  }
}
