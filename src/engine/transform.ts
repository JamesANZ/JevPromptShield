import { MAX_CONTENT_CHARS } from "../config.js";

export const MAX_INSPECTION_VARIANTS = 12;
export const MAX_TRANSFORMATION_DEPTH = 2;
const MAX_DECODED_TOKENS = 8;

export interface InspectionVariant {
  content: string;
  transformations: string[];
}

const HOMOGLYPHS: Readonly<Record<string, string>> = {
  "\u0391": "A",
  "\u0392": "B",
  "\u0395": "E",
  "\u0397": "H",
  "\u0399": "I",
  "\u039a": "K",
  "\u039c": "M",
  "\u039d": "N",
  "\u039f": "O",
  "\u03a1": "P",
  "\u03a4": "T",
  "\u03a7": "X",
  "\u03b1": "a",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u0410": "A",
  "\u0412": "B",
  "\u0415": "E",
  "\u041a": "K",
  "\u041c": "M",
  "\u041d": "H",
  "\u041e": "O",
  "\u0420": "P",
  "\u0421": "C",
  "\u0422": "T",
  "\u0425": "X",
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
};

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function normalizeUnicode(content: string): string | undefined {
  const normalized = content
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/[\u0391\u0392\u0395\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a7\u03b1\u03b5\u03b9\u03bf\u03c1\u03c4\u03c5\u03c7\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0430\u0435\u043e\u0440\u0441\u0443\u0445]/gu, (character) => HOMOGLYPHS[character] ?? character);
  return normalized === content ? undefined : normalized;
}

function printableText(bytes: Uint8Array): string | undefined {
  try {
    const decoded = UTF8_DECODER.decode(bytes);
    if (
      decoded.trim() === "" ||
      decoded.length > MAX_CONTENT_CHARS ||
      // Reject binary and control characters, but retain ordinary whitespace.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/u.test(decoded)
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function decodeBase64(content: string): string | undefined {
  const pattern = /[A-Za-z0-9+/_-]{16,2048}={0,2}/g;
  let replacements = 0;
  let changed = false;
  const transformed = content.replace(pattern, (token: string) => {
    if (replacements >= MAX_DECODED_TOKENS) return token;
    replacements += 1;
    const standard = token.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/u, "");
    if (standard.length % 4 === 1) return token;
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    let decoded: string | undefined;
    try {
      decoded = printableText(Buffer.from(padded, "base64"));
    } catch {
      return token;
    }
    if (decoded === undefined) return token;
    changed = true;
    return decoded;
  });
  return changed ? transformed : undefined;
}

function decodeHex(content: string): string | undefined {
  const pattern = /(?:0x[0-9a-fA-F]{16,2048}|[0-9a-fA-F]{16,2048}|(?:[0-9a-fA-F]{2}[ \t:_-]){7,1023}[0-9a-fA-F]{2})/g;
  let replacements = 0;
  let changed = false;
  const transformed = content.replace(pattern, (token: string) => {
    if (replacements >= MAX_DECODED_TOKENS) return token;
    replacements += 1;
    const compact = token.replace(/^0x/u, "").replace(/[ \t:_-]/gu, "");
    if (compact.length % 2 !== 0) return token;
    const decoded = printableText(Buffer.from(compact, "hex"));
    if (decoded === undefined) return token;
    changed = true;
    return decoded;
  });
  return changed ? transformed : undefined;
}

function decodeUrl(content: string): string | undefined {
  if (!/%[0-9a-fA-F]{2}/u.test(content)) return undefined;
  try {
    const transformed = decodeURIComponent(content);
    return printableText(Buffer.from(transformed, "utf8"));
  } catch {
    return undefined;
  }
}

const TRANSFORMS: ReadonlyArray<{
  label: string;
  apply: (content: string) => string | undefined;
}> = [
  { label: "unicode_normalize", apply: normalizeUnicode },
  { label: "base64_decode", apply: decodeBase64 },
  { label: "hex_decode", apply: decodeHex },
  { label: "url_decode", apply: decodeUrl },
];

/**
 * Return the original plus a small breadth-first set of inspection forms.
 * Decoded bytes must be valid, printable UTF-8. Invalid or oversized forms are skipped.
 */
export function inspectionVariants(content: string): InspectionVariant[] {
  const variants: InspectionVariant[] = [{ content, transformations: [] }];
  const seen = new Set([content]);
  let cursor = 0;
  while (cursor < variants.length && variants.length < MAX_INSPECTION_VARIANTS) {
    const current = variants[cursor];
    cursor += 1;
    if (!current || current.transformations.length >= MAX_TRANSFORMATION_DEPTH) continue;
    for (const transform of TRANSFORMS) {
      const transformed = transform.apply(current.content);
      if (
        transformed === undefined ||
        transformed.length > MAX_CONTENT_CHARS ||
        seen.has(transformed)
      ) {
        continue;
      }
      seen.add(transformed);
      variants.push({
        content: transformed,
        transformations: [...current.transformations, transform.label],
      });
      if (variants.length >= MAX_INSPECTION_VARIANTS) break;
    }
  }
  return variants;
}

export function transformationLabel(transformations: string[]): string {
  return transformations.length === 0 ? "original" : transformations.join(" > ");
}
