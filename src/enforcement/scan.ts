export interface ScanResult {
  simple: boolean;
  argv: string[];
  reason?: string;
}

/**
 * Prove a command is one simple argv list.
 * Quotes are honored. Any operator, expansion, substitution, or redirect
 * means the command is not eligible for a local ALLOW.
 */
export function scanCommand(command: string): ScanResult {
  const argv: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;

  const fail = (reason: string): ScanResult => ({
    simple: false,
    argv: [],
    reason,
  });

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === undefined) break;

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        continue;
      }
      current += ch;
      inWord = true;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined)
          return fail("The command has a trailing escape.");
        if (next === "\n") {
          i += 1;
          continue;
        }
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          current += next;
          inWord = true;
          i += 1;
          continue;
        }
        current += ch;
        inWord = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`" || ch === "$")
        return fail("The command expands a value inside quotes.");
      current += ch;
      inWord = true;
      continue;
    }

    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined) return fail("The command has a trailing escape.");
      if (next === "\n") {
        i += 1;
        continue;
      }
      current += next;
      inWord = true;
      i += 1;
      continue;
    }

    if (ch === "'") {
      quote = "'";
      inWord = true;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      inWord = true;
      continue;
    }
    if (ch === "$" || ch === "`")
      return fail("The command uses substitution or expansion.");
    if (
      ch === "\n" ||
      ch === ";" ||
      ch === "&" ||
      ch === "|" ||
      ch === "<" ||
      ch === ">" ||
      ch === "(" ||
      ch === ")"
    ) {
      return fail(
        "The command uses shell syntax beyond a single simple command.",
      );
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      if (inWord) {
        argv.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    if (ch.charCodeAt(0) < 32)
      return fail("The command contains a control character.");
    current += ch;
    inWord = true;
  }

  if (quote) return fail("The command has an unterminated quote.");
  if (inWord) argv.push(current);
  if (argv.length === 0) return fail("The command is empty.");
  return { simple: true, argv };
}
