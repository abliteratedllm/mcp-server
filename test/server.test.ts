import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { ApiClient, type Fetch } from "../src/api.ts";
import { CatalogCache, parseCatalog } from "../src/catalog.ts";
import { createServer } from "../src/server.ts";
import { CATALOG_BODY } from "./fixtures.ts";

const KEY = `sk-${"a".repeat(48)}`;

const ModelList = z.object({ count: z.number(), models: z.array(z.object({ id: z.string() })) });
const CostResult = z.object({ model: z.string(), tier: z.string(), cost_usd: z.object({ total: z.string() }) });

type Route = (init: RequestInit) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const CHAT_OK = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "glm-5.3-flash-abliterated",
  choices: [{ index: 0, message: { role: "assistant", content: "Rain hit the window." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 31, completion_tokens: 212, total_tokens: 243, prompt_tokens_details: { cached_tokens: 0 } },
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A server wired to a fake fetch, connected to a client over an in-memory transport. */
async function connect(o: { apiKey?: string; routes?: Record<string, Route>; chatTimeoutMs?: number } = {}) {
  const calls: { method: string; path: string; init: RequestInit }[] = [];
  const routes: Record<string, Route> = { "GET /v1/models": () => json(200, CATALOG_BODY), ...o.routes };
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    calls.push({ method, path, init });
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected request ${method} ${path}`);
    return route(init);
  };
  const api = new ApiClient({ apiKey: o.apiKey, userAgent: "test", fetch });
  const catalog = new CatalogCache(async () => parseCatalog(await api.listModels(AbortSignal.timeout(1000))));
  const server = createServer({
    api,
    catalog,
    config: { apiKey: o.apiKey, chatTimeoutMs: o.chatTimeoutMs ?? 5000 },
    version: "0.0.0-test",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  close = () => client.close();
  // callTool's declared result also covers the pre-2025 `toolResult` shape, which this server never sends.
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, calls, call };
}

const text = (result: CallToolResult, index = 0): string => {
  const block = result.content[index];
  assert.equal(block?.type, "text");
  return block.text;
};

describe("tools/list", () => {
  it("lists four tools with annotations, without touching the network", async () => {
    const { client, calls } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["chat", "estimate_cost", "get_balance", "list_models"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.list_models?.annotations?.readOnlyHint, true);
    assert.equal(byName.get_balance?.annotations?.readOnlyHint, true);
    assert.equal(byName.estimate_cost?.annotations?.readOnlyHint, true);
    assert.equal(byName.chat?.annotations?.readOnlyHint, false);
    assert.equal(byName.chat?.annotations?.destructiveHint, false);
    // Only the token counts are required; defaulted inputs stay optional for the caller.
    assert.deepEqual(byName.estimate_cost?.inputSchema.required, ["input_tokens", "output_tokens"]);
    assert.equal(byName.chat?.inputSchema.required, undefined);
    assert.equal(calls.length, 0);
  });

  it("reports the server's identity and instructions", async () => {
    const { client } = await connect();
    assert.equal(client.getServerVersion()?.name, "abliteratedllm");
    assert.match(client.getInstructions() ?? "", /spends the user's prepaid credit/);
  });
});

describe("list_models", () => {
  it("returns filtered models without sending a key, and caches the catalog", async () => {
    const { call, calls } = await connect({ apiKey: KEY });
    const result = await call("list_models", { variant: "abliterated" });
    assert.equal(result.isError, undefined);
    const data = ModelList.parse(result.structuredContent);
    assert.equal(data.count, 1);
    assert.equal(data.models[0]?.id, "glm-5.3-flash-abliterated");
    assert.deepEqual(JSON.parse(text(result)), result.structuredContent);
    await call("list_models", {});
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), null);
  });

  it("reports a catalog failure as a tool error", async () => {
    const { call } = await connect({ routes: { "GET /v1/models": () => new Response("<html>", { status: 502 }) } });
    const result = await call("list_models");
    assert.equal(result.isError, true);
    assert.match(text(result), /HTTP 502/);
  });
});

describe("get_balance", () => {
  it("explains a missing key without sending a request", async () => {
    const { call, calls } = await connect();
    const result = await call("get_balance");
    assert.equal(result.isError, true);
    assert.match(text(result), /ABLITERATEDLLM_API_KEY/);
    assert.equal(calls.length, 0);
  });

  it("passes the amounts through as strings", async () => {
    const balance = {
      balance_usd: "12.345678",
      held_usd: "0.000000",
      trial: false,
      available_usd: "12.345678",
      key_daily_remaining_usd: "4.500000",
      key_monthly_remaining_usd: null,
      key_lifetime_remaining_usd: "40.000000",
    };
    const { call, calls } = await connect({ apiKey: KEY, routes: { "GET /v1/balance": () => json(200, balance) } });
    const result = await call("get_balance");
    assert.deepEqual(result.structuredContent, balance);
    assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), `Bearer ${KEY}`);
  });

  it("explains a rejected key", async () => {
    const { call } = await connect({
      apiKey: KEY,
      routes: {
        "GET /v1/balance": () =>
          json(401, {
            error: { type: "authentication_error", code: "invalid_api_key", message: "Missing or invalid API key." },
          }),
      },
    });
    const result = await call("get_balance");
    assert.equal(result.isError, true);
    assert.match(text(result), /invalid_api_key .*dashboard\/keys/);
  });
});

describe("estimate_cost", () => {
  it("prices token counts with the catalog", async () => {
    const { call } = await connect();
    const result = await call("estimate_cost", { input_tokens: 31, output_tokens: 212 });
    const data = CostResult.parse(result.structuredContent);
    assert.equal(data.model, "glm-5.3-flash-abliterated");
    assert.equal(data.tier, "standard");
    assert.equal(data.cost_usd.total, "0.000076");
  });

  it("uses priority prices when asked", async () => {
    const { call } = await connect();
    const result = await call("estimate_cost", {
      model: "deepseek-v4.1-flash-1017",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      priority: true,
    });
    // 1M × 0.3375 + 1M × 1.35 at the fixture's priority prices
    assert.equal(CostResult.parse(result.structuredContent).cost_usd.total, "1.687500");
  });

  it("rejects unknown models, missing priority tiers and impossible counts", async () => {
    const { call } = await connect();
    const unknown = await call("estimate_cost", { model: "nope", input_tokens: 1, output_tokens: 1 });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /Unknown model "nope"\. Models: glm-5\.3-flash-abliterated/);
    const noPriority = await call("estimate_cost", { input_tokens: 1, output_tokens: 1, priority: true });
    assert.match(text(noPriority), /no priority tier/);
    const cached = await call("estimate_cost", { input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 });
    assert.match(text(cached), /cached_input_tokens/);
  });
});

describe("chat", () => {
  it("sends max_tokens and reasoning_effort by default and returns the reply with details", async () => {
    let sent: Record<string, unknown> = {};
    const { call, calls } = await connect({
      apiKey: KEY,
      routes: {
        "POST /v1/chat/completions": (init) => {
          sent = JSON.parse(String(init.body));
          return json(200, CHAT_OK);
        },
      },
    });
    const result = await call("chat", { prompt: "Open chapter one.", system: "You are a noir novelist." });
    assert.equal(result.isError, undefined);
    assert.deepEqual(sent, {
      model: "glm-5.3-flash-abliterated",
      messages: [
        { role: "system", content: "You are a noir novelist." },
        { role: "user", content: "Open chapter one." },
      ],
      max_tokens: 2048,
      reasoning_effort: "low",
    });
    assert.equal(text(result, 0), "Rain hit the window.");
    assert.match(text(result, 1), /Tokens: 31 input \(0 cached\), 212 output\. Estimated cost: \$0\.000076/);
    const chatCall = calls.find((c) => c.path === "/v1/chat/completions");
    assert.equal(new Headers(chatCall?.init.headers).get("authorization"), `Bearer ${KEY}`);
  });

  it("reports an error that arrives in a 200 body after keep-alive newlines", async () => {
    const { call } = await connect({
      apiKey: KEY,
      routes: {
        "POST /v1/chat/completions": () =>
          new Response(
            '\n\n\n\n\n\n{"error":{"type":"api_error","code":"upstream_error","message":"The model sent nothing for 2 minutes."}}',
            { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_long" } },
          ),
      },
    });
    const result = await call("chat", { prompt: "Write a long story." });
    assert.equal(result.isError, true);
    assert.match(text(result), /upstream_error \(HTTP 200, reported in the response body\)/);
    assert.match(text(result), /Request id: req_long/);
  });

  it("explains a spend cap and a busy model", async () => {
    const { call } = await connect({
      apiKey: KEY,
      routes: {
        "POST /v1/chat/completions": (init) =>
          JSON.parse(String(init.body)).model === "kimi-k3"
            ? json(
                429,
                { error: { type: "rate_limit_error", code: "capacity_exhausted", message: "All model replicas are busy." } },
                { "retry-after": "5" },
              )
            : json(402, {
                error: { type: "insufficient_quota", code: "key_spend_cap_reached", message: "Key spend cap reached." },
              }),
      },
    });
    assert.match(text(await call("chat", { prompt: "Hi", max_tokens: 100000 })), /lower max_tokens/);
    assert.match(text(await call("chat", { prompt: "Hi", model: "kimi-k3" })), /Retry after 5 s\./);
  });

  it("stops waiting at the configured timeout and aborts the request", async () => {
    let aborted = false;
    const { call } = await connect({
      apiKey: KEY,
      chatTimeoutMs: 50,
      routes: {
        "POST /v1/chat/completions": (init) => {
          const { promise, reject } = Promise.withResolvers<Response>();
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
          return promise;
        },
      },
    });
    const result = await call("chat", { prompt: "Think hard." });
    assert.equal(result.isError, true);
    assert.match(text(result), /cancelled the request/);
    assert.match(text(result), /ABLITERATEDLLM_TIMEOUT_SECONDS/);
    assert.equal(aborted, true);
  });

  it("validates its input before sending anything", async () => {
    const { call, calls } = await connect({ apiKey: KEY });
    assert.match(text(await call("chat", {})), /exactly one/);
    assert.match(
      text(await call("chat", { prompt: "a", messages: [{ role: "user", content: "b" }] })),
      /exactly one/,
    );
    const effort = await call("chat", { prompt: "a", reasoning_effort: "minimal" });
    assert.equal(effort.isError, true);
    assert.equal(calls.length, 0);
  });

  it("explains a missing key without sending a request", async () => {
    const { call, calls } = await connect();
    const result = await call("chat", { prompt: "Hi" });
    assert.equal(result.isError, true);
    assert.match(text(result), /chat needs an AbliteratedLLM API key/);
    assert.equal(calls.length, 0);
  });

  it("explains an empty reply that ran out of budget", async () => {
    const { call } = await connect({
      apiKey: KEY,
      routes: {
        "POST /v1/chat/completions": () =>
          json(200, {
            ...CHAT_OK,
            choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }],
          }),
      },
    });
    const result = await call("chat", { prompt: "Hi", max_tokens: 16 });
    assert.equal(result.isError, true);
    assert.match(text(result), /whole max_tokens budget \(16 tokens/);
  });
});
