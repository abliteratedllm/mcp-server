import * as z from "zod";

export const KEYS_URL = "https://abliteratedllm.dev/dashboard/keys";
export const BILLING_URL = "https://abliteratedllm.dev/dashboard/billing";
export const SUPPORT_EMAIL = "support@abliteratedllm.dev";

/** An error the API reported, either with an error status or inside a 200 body. */
export class ApiError extends Error {
  readonly status: number;
  /** The API's error code, e.g. `insufficient_balance`; null when the body had none. */
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | null;
  /**
   * True for an error that arrived in the body of a 200 response. A non-streaming request still
   * running after 90 seconds is answered 200 at once, so a later failure can only be reported there.
   */
  readonly inOkBody: boolean;

  constructor(init: {
    status: number;
    code: string | null;
    message: string;
    retryAfterSeconds: number | null;
    requestId: string | null;
    inOkBody: boolean;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.requestId = init.requestId;
    this.inOkBody = init.inOkBody;
  }
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date), or null. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

/** `{"error": {...}}` (OpenAI shape) or `{"error": "text"}`. */
const ErrorBody = z.object({
  error: z.union([
    z.string().transform((message) => ({ message, code: null })),
    z
      .object({ message: z.string().nullish(), code: z.string().nullish() })
      .transform((e) => ({ message: e.message ?? null, code: e.code ?? null })),
  ]),
});

/**
 * Parses an API response body. Returns the JSON value of a successful response, and throws
 * ApiError for an error status or for a body with a top-level `error` member, whatever the status.
 * Leading whitespace is skipped: a long non-streaming response starts with keep-alive newlines.
 */
export function parseApiBody(
  status: number,
  headers: { get(name: string): string | null },
  text: string,
): unknown {
  const ok = status >= 200 && status < 300;
  const fail = (code: string | null, message: string): ApiError =>
    new ApiError({
      status,
      code,
      message,
      retryAfterSeconds: parseRetryAfter(headers.get("retry-after")),
      requestId: headers.get("x-request-id"),
      inOkBody: ok,
    });

  const trimmed = text.trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    const snippet = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    if (!ok) throw fail(null, snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status} with an empty body.`);
    throw fail(null, trimmed ? "The API sent a response that isn't JSON." : "The API sent an empty response.");
  }
  const error = ErrorBody.safeParse(json);
  if (error.success) {
    throw fail(error.data.error.code, error.data.error.message ?? `HTTP ${status}`);
  }
  if (!ok) throw fail(null, `HTTP ${status}`);
  return json;
}

const HINTS: Record<string, string> = {
  invalid_api_key: `Check ABLITERATEDLLM_API_KEY in this MCP server's configuration. Keys are created at ${KEYS_URL}.`,
  account_suspended: `Contact ${SUPPORT_EMAIL}.`,
  account_banned: `Contact ${SUPPORT_EMAIL}.`,
  model_not_found: "Call list_models for the model ids.",
  insufficient_balance: `Top up at ${BILLING_URL}. A request needs enough balance for its input plus at least 256 output tokens.`,
  key_spend_cap_reached: `A request holds its whole max_tokens budget against the key's spend cap, so a lower max_tokens may fit. The caps are set at ${KEYS_URL}; get_balance shows what is left.`,
  rate_limit_exceeded:
    "Too many requests: wait for a running request to finish or for the per-minute window to reset. Trial accounts allow 1 request at a time and 10 per minute per key.",
  capacity_exhausted: "The model is busy. Retry shortly or pick another model.",
  model_unavailable: "The model has no serving capacity right now. Retry later or pick another model.",
  safety_unavailable: "Retry in a few seconds.",
  upstream_error: "Retry the request.",
};

/** A message for the MCP client: the API's error, what to do about it, and the request id. */
export function describeApiError(err: ApiError): string {
  const code = err.code ?? (err.status === 401 ? "invalid_api_key" : null);
  const parts = [
    `AbliteratedLLM API error${code ? ` ${code}` : ""} (HTTP ${err.status}${err.inOkBody ? ", reported in the response body" : ""}): ${err.message}`,
  ];
  const hint = code ? HINTS[code] : undefined;
  if (hint) parts.push(hint);
  if (err.retryAfterSeconds !== null) parts.push(`Retry after ${err.retryAfterSeconds} s.`);
  if (err.requestId) parts.push(`Request id: ${err.requestId}.`);
  return parts.join(" ");
}
