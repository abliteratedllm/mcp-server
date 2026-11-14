import { KEYS_URL, parseApiBody } from "./errors.ts";

export const API_BASE_URL = "https://api.abliteratedllm.dev/v1";

/** Timeout of the quick calls (catalog, balance). `chat` has its own, configurable one. */
export const QUICK_TIMEOUT_MS = 20_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Thrown before any request is sent when a tool needs the API key and none is configured. */
export class MissingKeyError extends Error {
  constructor(tool: string) {
    super(
      `${tool} needs an AbliteratedLLM API key. Create one at ${KEYS_URL} and set ABLITERATEDLLM_API_KEY in this MCP server's env configuration. list_models and estimate_cost work without a key.`,
    );
    this.name = "MissingKeyError";
  }
}

/** The network request failed before any response arrived (DNS, TLS, connection reset…). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause);
    super(`Could not reach ${API_BASE_URL}: ${detail}`);
    this.name = "NetworkError";
  }
}

export interface ApiClientOptions {
  apiKey: string | undefined;
  userAgent: string;
  fetch?: Fetch | undefined;
}

export class ApiClient {
  readonly #apiKey: string | undefined;
  readonly #userAgent: string;
  readonly #fetch: Fetch;

  constructor(options: ApiClientOptions) {
    this.#apiKey = options.apiKey;
    this.#userAgent = options.userAgent;
    this.#fetch = options.fetch ?? fetch;
  }

  get hasKey(): boolean {
    return this.#apiKey !== undefined;
  }

  /** `GET /v1/models`. Public: no key is sent. */
  listModels(signal: AbortSignal): Promise<unknown> {
    return this.#request("GET", "/models", { tool: null, signal });
  }

  /** `GET /v1/balance`. Spends nothing. */
  getBalance(signal: AbortSignal): Promise<unknown> {
    return this.#request("GET", "/balance", { tool: "get_balance", signal });
  }

  /** `POST /v1/chat/completions`, non-streaming. */
  createChatCompletion(body: object, signal: AbortSignal): Promise<unknown> {
    return this.#request("POST", "/chat/completions", { tool: "chat", signal, body });
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    o: { tool: string | null; signal: AbortSignal; body?: object },
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": this.#userAgent };
    if (o.tool !== null) {
      if (this.#apiKey === undefined) throw new MissingKeyError(o.tool);
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${API_BASE_URL}${path}`, {
        method,
        headers,
        signal: o.signal,
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      });
      text = await response.text();
    } catch (err) {
      if (o.signal.aborted) throw err;
      throw new NetworkError(err);
    }
    return parseApiBody(response.status, response.headers, text);
  }
}
