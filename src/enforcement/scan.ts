export interface ScanResult {
  simple: boolean;
  argv: string[];
  reason?: string;
}

type Quote = "single" | "double";

/**
 * Lexer phases. Quote mode and "in a word" used to be independent flags, so a
 * quote could disagree with whether a word was open.
 */
type Phase =
  | { name: "gap" }
  | { name: "unquoted"; current: string }
  | { name: "quoted"; quote: Quote; current: string }
  | { name: "escape"; current: string; resume: "unquoted" | Quote }
  | { name: "comment" };

const SHELL_BREAKS = new Set(["\n", ";", "&", "|", "<", ">", "(", ")"]);

/**
 * Prove a command is one simple argv list.
 * Quotes are honored. A `#` that starts a word begins a comment through the
 * end of the line. Any operator, expansion, substitution, redirect, or a
 * second line after a comment means the command is not eligible for a local ALLOW.
 */
export function scanCommand(command: string): ScanResult {
  const argv: string[] = [];
  let phase: Phase = { name: "gap" };

  const fail = (reason: string): ScanResult => ({
    simple: false,
    argv: [],
    reason,
  });

  const push = (current: string): void => {
    argv.push(current);
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === undefined) break;

    if (phase.name === "comment") {
      if (ch === "\n") {
        return fail(
          "The command uses shell syntax beyond a single simple command.",
        );
      }
      continue;
    }

    if (phase.name === "escape") {
      if (ch === "\n") {
        phase =
          phase.resume === "unquoted"
            ? phase.current === ""
              ? { name: "gap" }
              : { name: "unquoted", current: phase.current }
            : { name: "quoted", quote: phase.resume, current: phase.current };
        continue;
      }
      phase =
        phase.resume === "unquoted"
          ? { name: "unquoted", current: phase.current + ch }
          : {
              name: "quoted",
              quote: phase.resume,
              current: phase.current + ch,
            };
      continue;
    }

    if (phase.name === "quoted") {
      if (phase.quote === "single") {
        if (ch === "'") {
          phase = { name: "unquoted", current: phase.current };
          continue;
        }
        phase = {
          name: "quoted",
          quote: "single",
          current: phase.current + ch,
        };
        continue;
      }
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined) {
          return fail("The command has a trailing escape.");
        }
        if (
          next === "\n" ||
          next === "$" ||
          next === "`" ||
          next === '"' ||
          next === "\\"
        ) {
          phase = {
            name: "escape",
            current: phase.current,
            resume: "double",
          };
          continue;
        }
        phase = {
          name: "quoted",
          quote: "double",
          current: phase.current + ch,
        };
        continue;
      }
      if (ch === '"') {
        phase = { name: "unquoted", current: phase.current };
        continue;
      }
      if (ch === "`" || ch === "$") {
        return fail("The command expands a value inside quotes.");
      }
      phase = {
        name: "quoted",
        quote: "double",
        current: phase.current + ch,
      };
      continue;
    }

    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined) return fail("The command has a trailing escape.");
      phase = {
        name: "escape",
        current: phase.name === "unquoted" ? phase.current : "",
        resume: "unquoted",
      };
      continue;
    }

    if (ch === "'") {
      phase = {
        name: "quoted",
        quote: "single",
        current: phase.name === "unquoted" ? phase.current : "",
      };
      continue;
    }
    if (ch === '"') {
      phase = {
        name: "quoted",
        quote: "double",
        current: phase.name === "unquoted" ? phase.current : "",
      };
      continue;
    }

    if (ch === "#" && phase.name === "gap") {
      phase = { name: "comment" };
      continue;
    }

    if (ch === "$" || ch === "`") {
      return fail("The command uses substitution or expansion.");
    }
    if (SHELL_BREAKS.has(ch)) {
      return fail(
        "The command uses shell syntax beyond a single simple command.",
      );
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      if (phase.name === "unquoted") {
        push(phase.current);
        phase = { name: "gap" };
      }
      continue;
    }
    if (ch.charCodeAt(0) < 32) {
      return fail("The command contains a control character.");
    }
    phase = {
      name: "unquoted",
      current: phase.name === "unquoted" ? phase.current + ch : ch,
    };
  }

  if (phase.name === "quoted") {
    return fail("The command has an unterminated quote.");
  }
  if (phase.name === "escape") {
    return fail("The command has a trailing escape.");
  }
  if (phase.name === "unquoted") push(phase.current);
  if (argv.length === 0) return fail("The command is empty.");
  return { simple: true, argv };
}
