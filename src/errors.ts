export const SHIELD_ERROR_CODES = [
  "invalid_request",
  "oversize",
  "jev_auth",
  "jev_payment",
  "jev_rate_limit",
  "jev_unavailable",
  "jev_error",
] as const;

export type ShieldErrorCode = (typeof SHIELD_ERROR_CODES)[number];

const STATUS: Record<ShieldErrorCode, number> = {
  invalid_request: 400,
  oversize: 400,
  jev_auth: 401,
  jev_payment: 402,
  jev_rate_limit: 429,
  jev_unavailable: 502,
  jev_error: 502,
};

export class ShieldError extends Error {
  readonly code: ShieldErrorCode;
  readonly status: number;

  constructor(code: ShieldErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ShieldError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function isShieldError(error: unknown): error is ShieldError {
  return error instanceof ShieldError;
}
