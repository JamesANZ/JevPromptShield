import { basename } from "node:path";
import { MAX_COMMAND_CHARS } from "./config.js";
import { scanCommand } from "./scan.js";
import { findInjectionTrick } from "./tricks.js";

export type LocalOutcome = "allow" | "block" | "review";

export interface LocalClassification {
  outcome: LocalOutcome;
  reason: string;
}

const VERSION_BINS = new Set([
  "node",
  "npm",
  "pnpm",
  "yarn",
  "git",
  "tsc",
  "python",
  "python3",
]);
const BARE_READ_ONLY = new Set(["pwd", "whoami", "date", "hostname"]);

function executable(argv0: string): string {
  return basename(argv0);
}

function isVersionCheck(bin: string, args: string[]): boolean {
  if (!VERSION_BINS.has(bin) || args.length !== 1) return false;
  const flag = args[0];
  return (
    flag === "--version" || flag === "-v" || flag === "-V" || flag === "version"
  );
}

function isTestScript(args: string[]): boolean {
  if (args.length === 1 && args[0] === "test") return true;
  return args.length === 2 && args[0] === "run" && args[1] === "test";
}

function gitWrites(arg: string): boolean {
  return (
    arg === "--output" ||
    arg.startsWith("--output=") ||
    arg === "--ext-diff" ||
    arg === "--textconv" ||
    arg === "--binary"
  );
}

function gitBranchDeletes(arg: string): boolean {
  if (arg === "--delete" || arg.startsWith("--delete=")) return true;
  if (!arg.startsWith("-") || arg.startsWith("--")) return false;
  return /[dD]/.test(arg.slice(1));
}

function isReadOnlyGit(args: string[]): boolean {
  const sub = args[0];
  if (sub === undefined) return false;
  const rest = args.slice(1);
  if (sub === "status" || sub === "rev-parse") return true;
  if (sub === "diff" || sub === "log" || sub === "show")
    return !rest.some(gitWrites);
  if (sub === "branch") return !rest.some(gitBranchDeletes);
  return false;
}

function isReadOnly(argv: string[]): boolean {
  const bin = executable(argv[0] ?? "");
  const args = argv.slice(1);
  if (BARE_READ_ONLY.has(bin)) return args.every((arg) => arg.startsWith("-"));
  if (bin === "ls" || bin === "which" || bin === "echo" || bin === "printf")
    return true;
  if (isVersionCheck(bin, args)) return true;
  if ((bin === "npm" || bin === "pnpm" || bin === "yarn") && isTestScript(args))
    return true;
  if (
    bin === "node" &&
    args.length === 1 &&
    (args[0] === "--version" || args[0] === "-v")
  )
    return true;
  if (bin === "git") return isReadOnlyGit(args);
  return false;
}

function isRootTarget(target: string): boolean {
  return (
    target === "/" ||
    target === "/*" ||
    target === "~" ||
    target === "~/" ||
    target === "$HOME" ||
    target === "$HOME/" ||
    target === "${HOME}" ||
    target === "${HOME}/"
  );
}

function rmArgvWipesRoot(argv: string[]): boolean {
  if (executable(argv[0] ?? "") !== "rm") return false;
  let recursive = false;
  let force = false;
  let afterDash = false;
  const targets: string[] = [];
  for (const arg of argv.slice(1)) {
    if (afterDash) {
      targets.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDash = true;
      continue;
    }
    if (arg === "--recursive") {
      recursive = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (arg.startsWith("-")) {
      const letters = arg.slice(1);
      if (letters.includes("r") || letters.includes("R")) recursive = true;
      if (letters.includes("f")) force = true;
      continue;
    }
    targets.push(arg);
  }
  return recursive && force && targets.some(isRootTarget);
}

function rawRootWipe(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ");
  const target = "(?:\\/\\*|\\/|~\\/?|\\$HOME\\/?|\\$\\{HOME\\}\\/?)(?:\\s|$)";
  const patterns = [
    new RegExp(
      String.raw`\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:--\s+)?${target}`,
    ),
    new RegExp(
      String.raw`\brm\s+-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*\s+(?:--\s+)?${target}`,
    ),
    new RegExp(String.raw`\brm\s+--recursive\s+--force\s+(?:--\s+)?${target}`),
    new RegExp(String.raw`\brm\s+--force\s+--recursive\s+(?:--\s+)?${target}`),
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function wipesRoot(command: string): boolean {
  const scanned = scanCommand(command);
  if (scanned.simple && rmArgvWipesRoot(scanned.argv)) return true;
  return rawRootWipe(command);
}

function isForkBomb(command: string): boolean {
  const compact = command.replace(/\s+/g, "");
  return compact.includes(":(){:|:&};:");
}

function formatsFilesystem(command: string): boolean {
  return /\bmkfs(?:\.[A-Za-z0-9]+)?\b/.test(command);
}

function writesRawDisk(command: string): boolean {
  if (
    /\bdd\b/.test(command) &&
    /\bof=\/dev\/(?:sd|nvme|vd|xvd|mmcblk|disk)/.test(command)
  )
    return true;
  return />\s*\/dev\/(?:sd|nvme|vd|xvd|mmcblk|disk)/.test(command);
}

function isForcePush(command: string): boolean {
  if (!/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return false;
  if (/(?:^|\s)--force(?:-with-lease)?(?:=|\s|$)/.test(command)) return true;
  return /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?=\s|$)/.test(command);
}

function namesProtectedBranch(command: string): boolean {
  return /(?:^|[\s:])(?:refs\/heads\/)?(main|master)(?:\s|$)/.test(command);
}

function forcePushToProtected(
  command: string,
  gitBranch: string | undefined,
): boolean {
  if (!isForcePush(command)) return false;
  if (namesProtectedBranch(command)) return true;
  const scanned = scanCommand(command);
  if (!scanned.simple || executable(scanned.argv[0] ?? "") !== "git")
    return false;
  if (scanned.argv[1] !== "push") return false;
  const positional = scanned.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("-"));
  const ref = positional[1];
  if (ref !== undefined) {
    return (
      ref === "main" ||
      ref === "master" ||
      ref.endsWith(":main") ||
      ref.endsWith(":master")
    );
  }
  return (
    positional.length <= 1 && (gitBranch === "main" || gitBranch === "master")
  );
}

/**
 * Local policy for commands whose shape is enough.
 * `review` means the caller should ask Jev. Remote-script pipes stay in
 * `review` because the URL and the shell on the right-hand side need a judgement.
 */
export function classifyCommand(
  command: string,
  hints?: { gitBranch?: string; description?: string },
): LocalClassification {
  const trick =
    findInjectionTrick(command) ??
    (hints?.description ? findInjectionTrick(hints.description) : undefined);
  if (trick) return { outcome: "block", reason: trick };
  if (isForkBomb(command)) {
    return { outcome: "block", reason: "Fork bomb blocked before execution." };
  }
  if (writesRawDisk(command)) {
    return {
      outcome: "block",
      reason: "Raw disk write blocked before execution.",
    };
  }
  if (formatsFilesystem(command)) {
    return {
      outcome: "block",
      reason: "Filesystem format command blocked before execution.",
    };
  }
  if (wipesRoot(command)) {
    return {
      outcome: "block",
      reason:
        "Recursive delete of a root or home directory blocked before execution.",
    };
  }
  if (forcePushToProtected(command, hints?.gitBranch)) {
    return {
      outcome: "block",
      reason: "Force-push to a protected branch blocked before execution.",
    };
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return {
      outcome: "block",
      reason:
        "Command exceeds the review limit. Shield does not truncate it into a shorter command.",
    };
  }

  const scanned = scanCommand(command);
  if (!scanned.simple) {
    return {
      outcome: "review",
      reason: scanned.reason ?? "Command needs review.",
    };
  }
  if (isReadOnly(scanned.argv)) {
    return {
      outcome: "allow",
      reason: "Read-only command allowed by local policy.",
    };
  }
  return {
    outcome: "review",
    reason: "Local policy does not treat this command as obviously safe.",
  };
}
