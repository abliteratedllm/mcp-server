import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { type ApiClient, MissingKeyError, QUICK_TIMEOUT_MS } from "./api.ts";
import { Balance, parseBalance } from "./balance.ts";
import { type CatalogCache, CatalogModel, DEFAULT_MODEL, filterModels } from "./catalog.ts";
import {
  buildChatRequest,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REASONING_EFFORT,
  describeChatResult,
  parseChatCompletion,
  REASONING_EFFORTS,
} from "./chat.ts";
import { type Config, MAX_TIMEOUT_SECONDS } from "./config.ts";
import { estimateCost, type TokenCounts } from "./cost.ts";
import { ApiError, describeApiError } from "./errors.ts";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ServerDeps {
  api: ApiClient;
  catalog: CatalogCache;
  config: Config;
  version: string;
}

/** How often `chat` sends a progress notification while it waits, when the client asked for progress. */
export const PROGRESS_INTERVAL_MS = 10_000;

const INSTRUCTIONS = `Tools for the AbliteratedLLM API (https://abliteratedllm.dev), an OpenAI-compatible, pay-per-token API for open-weight models.
- list_models and estimate_cost read the public catalog and need no API key.
- get_balance needs ABLITERATEDLLM_API_KEY and spends nothing.
- chat sends the prompt to an AbliteratedLLM model and spends the user's prepaid credit. Call it only when the user asks for an AbliteratedLLM model's answer.`;

const Tokens = z.number().int().min(0);
const PriceList = z.object({ input: z.string(), output: z.string(), cached_input: z.string() });

/** A successful result with structured content and the same JSON as text, for clients without structured output. */
function structured(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof ApiError) text = describeApiError(err);
  else if (err instanceof Error && err.name === "TimeoutError") {
    text = `The AbliteratedLLM API did not answer within ${QUICK_TIMEOUT_MS / 1000} s. Try again shortly.`;
  } else text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text }], isError: true };
}

/** Runs a tool body, turning any failure into an isError result the model can read. */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    return errorResult(err);
  }
}

/** Sends `notifications/progress` every PROGRESS_INTERVAL_MS if the request carried a progress token. Returns a stop function. */
function startProgress(extra: Extra, model: string, timeoutMs: number): () => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: elapsed, total: timeoutMs / 1000, message: `Waiting for ${model} (${elapsed} s)` },
      })
      .catch(() => {});
  }, PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

export function createServer(deps: ServerDeps): McpServer {
  const { api, catalog, config } = deps;
  const server = new McpServer(
    { name: "abliteratedllm", title: "AbliteratedLLM", version: deps.version, websiteUrl: "https://abliteratedllm.dev" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_models",
    {
      title: "List AbliteratedLLM models",
      description:
        'List the models in the AbliteratedLLM catalog with context length, max output tokens, input types (text, image, video) and prices in USD per 1M tokens (input, output, cached input, and priority tier where offered). variant "abliterated" means the refusal behavior was removed from the weights; "stock" models are the vendors\' original weights. Every model reasons. Reads the public catalog; no API key needed.',
      inputSchema: {
        variant: z.enum(["abliterated", "stock"]).optional().describe("Only models of this variant."),
        vision: z.boolean().optional().describe("true: only models that accept image input; false: only models that don't."),
        max_output_price: z
          .number()
          .min(0)
          .max(1_000_000)
          .optional()
          .describe("Only models whose output price is at most this many USD per 1M tokens."),
      },
      outputSchema: { prices: z.literal("USD per 1M tokens"), count: z.number(), models: z.array(CatalogModel) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (filter) =>
      guard(async () => {
        const { models } = await catalog.get();
        const selected = filterModels(models, filter);
        return structured({ prices: "USD per 1M tokens", count: selected.length, models: selected });
      }),
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get AbliteratedLLM balance",
      description:
        "Show the balance of the account that owns ABLITERATEDLLM_API_KEY: credit available for new requests, credit held by running requests, whether it is a trial account, and what is left of the key's daily, monthly and lifetime spend caps (null: no cap). Amounts are USD decimal strings. Spends nothing, so it is also the way to check that the key works.",
      outputSchema: Balance.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (extra) =>
      guard(async () => {
        const body = await api.getBalance(AbortSignal.any([extra.signal, AbortSignal.timeout(QUICK_TIMEOUT_MS)]));
        return structured(parseBalance(body));
      }),
  );

  server.registerTool(
    "estimate_cost",
    {
      title: "Estimate AbliteratedLLM request cost",
      description:
        "Estimate the USD cost of a request from token counts and the live catalog prices, with the API's billing formula: (input - cached) × input price + cached × cached-input price + output × output price, per 1M tokens, rounded up to $0.000001. You supply the token counts: this server has no tokenizer, so the result is an estimate. Reasoning tokens are output tokens. To see the most a chat call can cost, pass its max_tokens as output_tokens. No API key needed.",
      inputSchema: {
        model: z.string().min(1).default(DEFAULT_MODEL).describe(`Model id from list_models. Default ${DEFAULT_MODEL}.`),
        input_tokens: Tokens.describe("Prompt tokens, cached ones included."),
        output_tokens: Tokens.describe("Output tokens, reasoning tokens included."),
        cached_input_tokens: Tokens.default(0).describe("How many of input_tokens are read from the prompt cache. Default 0."),
        priority: z.boolean().default(false).describe('Use the priority-tier prices (service_tier "priority"). Default false.'),
      },
      outputSchema: {
        model: z.string(),
        tier: z.enum(["standard", "priority"]),
        tokens: z.object({ input_tokens: Tokens, cached_input_tokens: Tokens, output_tokens: Tokens }),
        prices_usd_per_1m_tokens: PriceList,
        cost_usd: z.object({ uncached_input: z.string(), cached_input: z.string(), output: z.string(), total: z.string() }),
        note: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guard(async () => {
        const { models } = await catalog.get();
        const model = models.find((m) => m.id === args.model);
        if (!model) {
          throw new Error(`Unknown model "${args.model}". Models: ${models.map((m) => m.id).join(", ")}.`);
        }
        const prices = args.priority ? model.pricing.priority : model.pricing;
        if (!prices) throw new Error(`${model.id} has no priority tier.`);
        const tokens: TokenCounts = {
          input_tokens: args.input_tokens,
          cached_input_tokens: args.cached_input_tokens,
          output_tokens: args.output_tokens,
        };
        return structured({
          model: model.id,
          tier: args.priority ? "priority" : "standard",
          tokens,
          prices_usd_per_1m_tokens: { input: prices.input, output: prices.output, cached_input: prices.cached_input },
          cost_usd: estimateCost(prices, tokens),
          note: "An estimate from the token counts given and the current catalog prices. While a request runs, the API also holds its whole max_tokens budget against the balance and the key's spend caps; only actual usage is charged.",
        });
      }),
  );

  const timeoutSeconds = config.chatTimeoutMs / 1000;
  server.registerTool(
    "chat",
    {
      title: "Chat with an AbliteratedLLM model",
      description: `Send a prompt, or a short text conversation, to an AbliteratedLLM model and return its reply with token usage and an estimated cost. This spends the user's prepaid AbliteratedLLM credit: call it only when the user asks for an AbliteratedLLM model's answer. Text only, one non-streamed reply. Defaults: model ${DEFAULT_MODEL}, max_tokens ${DEFAULT_MAX_TOKENS} (reasoning tokens count toward it), reasoning_effort ${DEFAULT_REASONING_EFFORT}. This server stops waiting after ${timeoutSeconds} s, so keep max_tokens and reasoning_effort modest. Trial accounts allow 1 request at a time and at most 4096 output tokens. Needs ABLITERATEDLLM_API_KEY.`,
      inputSchema: {
        prompt: z.string().min(1).optional().describe("The user message. Pass either prompt or messages."),
        messages: z
          .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
          .min(1)
          .optional()
          .describe("A conversation, oldest message first. Pass either prompt or messages."),
        system: z.string().optional().describe("System prompt, sent as a system message before the others."),
        model: z.string().min(1).default(DEFAULT_MODEL).describe(`Model id from list_models. Default ${DEFAULT_MODEL}.`),
        max_tokens: z
          .number()
          .int()
          .min(1)
          .default(DEFAULT_MAX_TOKENS)
          .describe(
            `Output budget, reasoning tokens included. Default ${DEFAULT_MAX_TOKENS}. The API lowers it to the model's max output (and to 4096 on trial accounts). The whole budget is held against the balance and the key's spend caps while the request runs.`,
          ),
        reasoning_effort: z
          .enum(REASONING_EFFORTS)
          .default(DEFAULT_REASONING_EFFORT)
          .describe(`How much the model reasons before answering. Default ${DEFAULT_REASONING_EFFORT}; higher takes longer and uses more output tokens.`),
        temperature: z.number().min(0).max(2).optional().describe("Sampling temperature, 0 to 2. Omit for the model's default."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, extra) =>
      guard(async () => {
        const body = buildChatRequest(args);
        if (!api.hasKey) throw new MissingKeyError("chat");
        // Prices for the cost estimate, fetched alongside the request so the reply is not delayed.
        const models = catalog.get().then(
          (snapshot) => snapshot.models,
          () => null,
        );
        const timeout = AbortSignal.timeout(config.chatTimeoutMs);
        const stopProgress = startProgress(extra, body.model, config.chatTimeoutMs);
        let json: unknown;
        try {
          json = await api.createChatCompletion(body, AbortSignal.any([extra.signal, timeout]));
        } catch (err) {
          if (timeout.aborted && !extra.signal.aborted) {
            throw new Error(
              `No answer from ${body.model} within ${timeoutSeconds} s, so this server cancelled the request. A cancelled request is billed for its estimated input and any output generated before it stopped. Try a lower max_tokens or reasoning_effort, or a faster model. If your MCP host allows tool calls longer than ${timeoutSeconds} s, raise ABLITERATEDLLM_TIMEOUT_SECONDS (up to ${MAX_TIMEOUT_SECONDS}).`,
            );
          }
          throw err;
        } finally {
          stopProgress();
        }
        const result = parseChatCompletion(json);
        const priced = (await models)?.find((m) => m.id === body.model);
        const estimatedCostUsd = result.tokens && priced ? estimateCost(priced.pricing, result.tokens).total : null;
        const { reply, details, isError } = describeChatResult(result, {
          model: body.model,
          maxTokens: body.max_tokens,
          estimatedCostUsd,
        });
        return {
          content: [
            { type: "text", text: reply },
            { type: "text", text: details },
          ],
          ...(isError ? { isError: true } : {}),
        };
      }),
  );

  return server;
}
