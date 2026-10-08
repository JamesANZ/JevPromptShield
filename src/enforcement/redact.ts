const REPLACEMENTS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted]",
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    replacement: "$1[redacted]@",
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: "Bearer [redacted]",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted]" },
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: "[redacted]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "[redacted]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[redacted]" },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: "[redacted]" },
  {
    pattern:
      /\b((?:api[_-]?key|access[_-]?key|token|password|secret|passwd)=)([^\s'"&|;]+)/gi,
    replacement: "$1[redacted]",
  },
];

/** Remove credential-shaped substrings. The surrounding command stays so policy can still see the action. */
export function redactText(value: string): string {
  let redacted = value;
  for (const { pattern, replacement } of REPLACEMENTS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}
