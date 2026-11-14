import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChatRequest, describeChatResult, parseChatCompletion } from "../src/chat.ts";
import { readConfig } from "../src/config.ts";

const base = { model: "glm-5.3-flash-abliterated", max_tokens: 2048, reasoning_effort: "low" } as const;

describe("buildChatRequest", () => {
  it("turns prompt and system into messages and always sends max_tokens and reasoning_effort", () => {
    assert.deepEqual(buildChatRequest({ ...base, prompt: "Hi", system: "Be brief." }), {
      model: "glm-5.3-flash-abliterated",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
      max_tokens: 2048,
      reasoning_effort: "low",
    });
  });

  it("passes a conversation through and adds temperature only when given", () => {
    const messages = [
      { role: "user", content: "Name a color." },
      { role: "assistant", content: "Teal." },
      { role: "user", content: "Another." },
    ] as const;
    const body = buildChatRequest({ ...base, messages: [...messages], temperature: 0.2 });
    assert.deepEqual(body.messages, messages);
    assert.equal(body.temperature, 0.2);
    assert.equal("temperature" in buildChatRequest({ ...base, prompt: "x" }), false);
  });

  it("requires exactly one of prompt and messages", () => {
    assert.throws(() => buildChatRequest({ ...base }), /exactly one/);
    assert.throws(() => buildChatRequest({ ...base, prompt: "a", messages: [{ role: "user", content: "b" }] }), /exactly one/);
  });
});

describe("parseChatCompletion", () => {
  it("reads the reply, finish reason and usage", () => {
    const result = parseChatCompletion({
      id: "x",
      object: "chat.completion",
      model: "glm-5.3-flash-abliterated",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 31,
        completion_tokens: 212,
        total_tokens: 243,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 180 },
      },
    });
    assert.deepEqual(result, {
      model: "glm-5.3-flash-abliterated",
      content: "Hello.",
      finish_reason: "stop",
      tokens: { input_tokens: 31, cached_input_tokens: 8, output_tokens: 212 },
      reasoning_tokens: 180,
    });
  });

  it("tolerates missing usage and null content", () => {
    const result = parseChatCompletion({ choices: [{ message: { content: null }, finish_reason: "length" }] });
    assert.equal(result.content, "");
    assert.equal(result.tokens, null);
  });

  it("rejects a body without choices", () => {
    assert.throws(() => parseChatCompletion({ choices: [] }), /no choices/);
    assert.throws(() => parseChatCompletion({}), /no choices/);
  });
});

describe("describeChatResult", () => {
  const options = { model: "glm-5.3-flash-abliterated", maxTokens: 2048, estimatedCostUsd: "0.000076" };
  const tokens = { input_tokens: 31, cached_input_tokens: 0, output_tokens: 212 };

  it("returns the reply and a details line with usage and the estimate", () => {
    const out = describeChatResult(
      { model: null, content: "Hello.", finish_reason: "stop", tokens, reasoning_tokens: null },
      options,
    );
    assert.equal(out.reply, "Hello.");
    assert.equal(out.isError, false);
    assert.equal(
      out.details,
      "Model: glm-5.3-flash-abliterated. Finish reason: stop. Tokens: 31 input (0 cached), 212 output. Estimated cost: $0.000076 (usage × catalog prices, not the billed amount).",
    );
  });

  it("flags a reply cut off at max_tokens", () => {
    const out = describeChatResult(
      { model: null, content: "Partial", finish_reason: "length", tokens, reasoning_tokens: 100 },
      options,
    );
    assert.equal(out.isError, false);
    assert.match(out.details, /212 output, 100 of them reasoning/);
    assert.match(out.details, /cut off at max_tokens \(2048\)/);
  });

  it("explains an empty reply that used the whole budget on reasoning", () => {
    const out = describeChatResult(
      { model: null, content: "", finish_reason: "length", tokens, reasoning_tokens: 2048 },
      options,
    );
    assert.equal(out.isError, true);
    assert.match(out.reply, /Raise max_tokens or lower reasoning_effort/);
  });
});

describe("readConfig", () => {
  it("reads the key and the timeout", () => {
    assert.deepEqual(readConfig({}), { apiKey: undefined, chatTimeoutMs: 55_000 });
    assert.deepEqual(readConfig({ ABLITERATEDLLM_API_KEY: "  sk-abc  ", ABLITERATEDLLM_TIMEOUT_SECONDS: "300" }), {
      apiKey: "sk-abc",
      chatTimeoutMs: 300_000,
    });
    assert.equal(readConfig({ ABLITERATEDLLM_API_KEY: "   " }).apiKey, undefined);
  });

  it("rejects a timeout outside 1 to 600 seconds", () => {
    for (const value of ["0", "601", "1.5", "abc"]) {
      assert.throws(() => readConfig({ ABLITERATEDLLM_TIMEOUT_SECONDS: value }), /ABLITERATEDLLM_TIMEOUT_SECONDS/);
    }
  });
});
