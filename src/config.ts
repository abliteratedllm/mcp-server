/**
 * How long `chat` waits for an answer. Many MCP hosts (Claude Desktop, Cursor, and others built on
 * the MCP TypeScript SDK's default) cancel a tool call after 60 seconds, so the default stops just
 * before that and returns an explanation instead of a bare host timeout.
 */
export const DEFAULT_TIMEOUT_SECONDS = 55;
/** The API's own limit per request is 10 minutes. */
export const MAX_TIMEOUT_SECONDS = 600;

export interface Config {
  /** From ABLITERATEDLLM_API_KEY; undefined when unset or blank. */
  apiKey: string | undefined;
  /** From ABLITERATEDLLM_TIMEOUT_SECONDS, in milliseconds. */
  chatTimeoutMs: number;
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.ABLITERATEDLLM_API_KEY?.trim() || undefined;
  const rawTimeout = env.ABLITERATEDLLM_TIMEOUT_SECONDS?.trim();
  let seconds = DEFAULT_TIMEOUT_SECONDS;
  if (rawTimeout) {
    seconds = Number(rawTimeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
      throw new Error(
        `ABLITERATEDLLM_TIMEOUT_SECONDS must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}; got ${JSON.stringify(rawTimeout)}.`,
      );
    }
  }
  return { apiKey, chatTimeoutMs: seconds * 1000 };
}
