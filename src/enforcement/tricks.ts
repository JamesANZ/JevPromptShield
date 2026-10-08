/**
 * Keyless detection for instruction-override and compromise canaries.
 * The text is folded first so zero-width characters and punctuation cannot hide the phrase.
 */

const TRICKS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  {
    reason: "Instruction-override trick blocked before execution.",
    pattern:
      /\b(?:ignore|ignoring|disregard|disregarding|forget|forgetting|override|overriding)\b(?: \w+){0,6} \b(?:previous|prior|above|all|your|system|developer|safety|original|earlier)\b(?: \w+){0,5} \b(?:instructions|instruction|rules|rule|prompt|prompts|policy|policies|guidelines|restrictions)\b/,
  },
  {
    reason: "Instruction-override trick blocked before execution.",
    pattern:
      /\bforget\b(?: \w+){0,4} \b(?:everything|all)\b(?: \w+){0,3} \b(?:above|before|prior)\b/,
  },
  {
    reason: "Instruction-override trick blocked before execution.",
    pattern:
      /\bdo not follow\b(?: \w+){0,6} \b(?:previous|prior|original|system|your)\b/,
  },
  {
    reason: "Instruction-override trick blocked before execution.",
    pattern: /\b(?:new|updated) (?:priority )?instructions\b/,
  },
  {
    reason: "Jailbreak trick blocked before execution.",
    pattern:
      /\b(?:you have no restrictions|disable(?: your)? safety(?: policy)?|from now on you have no restrictions|no restrictions from now on)\b/,
  },
  {
    reason: "Secret-extraction trick blocked before execution.",
    pattern:
      /\b(?:reveal|show|print|output|repeat|dump)\b(?: \w+){0,6} \b(?:system prompt|hidden prompt|developer message|api keys|original instructions)\b/,
  },
  {
    reason: "Compromise canary blocked before execution.",
    pattern: /\bi have been pwned\b|\bive been pwned\b|\bi ve been pwned\b/,
  },
];

function foldings(value: string): string[] {
  const base = value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const invisible = /[\u200B-\u200D\uFEFF\u00AD]/g;
  return [base.replace(invisible, ""), base.replace(invisible, " ")];
}

function squash(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTrickText(value: string): string {
  return squash(foldings(value)[0] ?? "");
}

/** Returns a block reason when the text is an obvious prompt-injection trick. */
export function findInjectionTrick(value: string): string | undefined {
  for (const folded of foldings(value)) {
    const normalized = squash(folded);
    if (normalized === "") continue;
    for (const trick of TRICKS) {
      if (trick.pattern.test(normalized)) return trick.reason;
    }
  }
  return undefined;
}
