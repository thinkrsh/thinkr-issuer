// Errors the issuer reports to the dashboard, with the HTTP status of each code.
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { ErrorBody, ErrorCode } from '../contract.js';

export const ERROR_STATUS = {
  invalid_request: 400,
  rate_limited: 429,
  upstream_error: 502,
  internal_error: 500,
  key_changed: 409,
  payment_pending: 409,
  payment_invalid: 400,
  payment_used: 409,
} as const satisfies Record<ErrorCode, ContentfulStatusCode>;

export class IssuerError extends Error {
  override readonly name = 'IssuerError';
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: ErrorCode, message: string, status: ContentfulStatusCode = ERROR_STATUS[code]) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}
