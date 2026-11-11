import { ShieldError } from "./errors.js";

/**
 * Exactly one of text, image, or audio. Callers used to keep three independent
 * presence flags, which also allowed "none" and "more than one".
 */
export type Modality =
  | { modality: "text"; value: unknown }
  | { modality: "image"; value: unknown }
  | { modality: "audio"; value: unknown };

export function resolveModality(
  fields: { content?: unknown; image?: unknown; audio?: unknown },
  wrongCount: string,
): Modality {
  const present: Modality[] = [];
  if (fields.content !== undefined) {
    present.push({ modality: "text", value: fields.content });
  }
  if (fields.image !== undefined) {
    present.push({ modality: "image", value: fields.image });
  }
  if (fields.audio !== undefined) {
    present.push({ modality: "audio", value: fields.audio });
  }
  const chosen = present[0];
  if (present.length !== 1 || chosen === undefined) {
    throw new ShieldError("invalid_request", wrongCount);
  }
  return chosen;
}
