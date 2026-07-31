/**
 * Typed error hierarchy for the FloorLingo SDK.
 *
 * The FloorLingo API returns NestJS-default errors of the shape:
 *   `{ statusCode: number, message: string | string[], error: string }`
 * This module maps that to a typed, ergonomic error tree so callers can
 * `instanceof`-check or branch on `.status`.
 *
 * @packageDocumentation
 */

/** Base class for every error thrown by the SDK. */
export class FloorLingoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FloorLingoError';
  }
}

/**
 * Thrown when the API responds with a non-2xx status. Carries the HTTP status
 * code and the parsed error body (or the raw text if the body was not JSON).
 *
 * Use the static {@link FloorLingoApiError.fromResponse} factory in most cases.
 */
export class FloorLingoApiError extends FloorLingoError {
  /** HTTP status code (e.g. 400, 404, 409, 429, 501). */
  readonly status: number;
  /** Parsed JSON body if available, otherwise the raw response text. */
  readonly body: unknown;
  /** Value of the `error` field in the NestJS error envelope, if present. */
  readonly errorKind?: string;

  constructor(message: string, status: number, body: unknown, errorKind?: string) {
    super(message);
    this.name = 'FloorLingoApiError';
    this.status = status;
    this.body = body;
    this.errorKind = errorKind;
  }

  /** Build an {@link FloorLingoApiError} from a fetch Response, awaiting its body. */
  static async fromResponse(res: Response, context: string): Promise<FloorLingoApiError> {
    // An opaque unfollowed redirect (we set `redirect: 'manual'`) surfaces as status 0, not a 3xx.
    // Give it a clear message instead of "FloorLingo API 0": the redirect was deliberately not followed
    // so the API key is never re-sent to the redirect target.
    if (res.status === 0) {
      return new FloorLingoApiError(
        `Unexpected redirect (not followed; the API key is never re-sent to a redirect target) — ${context}`,
        0,
        undefined,
      );
    }
    let body: unknown = undefined;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const env = isNestEnvelope(body) ? body : undefined;
    const messageText = describeMessage(env?.message ?? body ?? res.statusText);
    const message = `FloorLingo API ${res.status} ${res.statusText} — ${context}: ${messageText}`;
    return new FloorLingoApiError(message, res.status, body, env?.error);
  }
}

/** 401 Unauthorized — missing or invalid API key. */
export class FloorLingoAuthError extends FloorLingoApiError {}
/** 403 Forbidden — the API key's role is insufficient for this endpoint. */
export class FloorLingoForbiddenError extends FloorLingoApiError {}
/** 404 Not Found. */
export class FloorLingoNotFoundError extends FloorLingoApiError {}
/** 409 Conflict — typically an {@link EngineNotReadyError} from the backend. */
export class FloorLingoConflictError extends FloorLingoApiError {}
/** 429 Too Many Requests — rate limited. */
export class FloorLingoRateLimitError extends FloorLingoApiError {}
/** 501 Not Implemented — the active engine does not support this operation. */
export class FloorLingoNotImplementedError extends FloorLingoApiError {}

/** Thrown when a request exceeds the configured timeout. */
export class FloorLingoTimeoutError extends FloorLingoError {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'FloorLingoTimeoutError';
  }
}

/**
 * Construct the most specific {@link FloorLingoApiError} subclass for a status code.
 * Falls back to the generic {@link FloorLingoApiError} for unmapped statuses.
 */
export function classifyApiError(status: number, message: string, body: unknown, errorKind?: string): FloorLingoApiError {
  switch (status) {
    case 401:
      return new FloorLingoAuthError(message, status, body, errorKind);
    case 403:
      return new FloorLingoForbiddenError(message, status, body, errorKind);
    case 404:
      return new FloorLingoNotFoundError(message, status, body, errorKind);
    case 409:
      return new FloorLingoConflictError(message, status, body, errorKind);
    case 429:
      return new FloorLingoRateLimitError(message, status, body, errorKind);
    case 501:
      return new FloorLingoNotImplementedError(message, status, body, errorKind);
    default:
      return new FloorLingoApiError(message, status, body, errorKind);
  }
}

/** Narrow the NestJS error envelope shape: `{ statusCode, message, error }`. */
interface NestErrorEnvelope {
  statusCode: number;
  message: string | string[];
  error: string;
}

function isNestEnvelope(body: unknown): body is NestErrorEnvelope {
  return typeof body === 'object' && body !== null && 'statusCode' in body && 'message' in body && 'error' in body;
}

function describeMessage(message: string | string[] | unknown): string {
  if (Array.isArray(message)) return message.join(', ');
  if (typeof message === 'string') return message;
  return String(message);
}
