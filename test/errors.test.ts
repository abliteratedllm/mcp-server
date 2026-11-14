import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, describeApiError, parseApiBody, parseRetryAfter } from "../src/errors.ts";

const noHeaders = new Headers();

function caught(run: () => unknown): ApiError {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected an ApiError");
}

describe("parseApiBody", () => {
  it("returns the JSON of a successful response", () => {
    assert.deepEqual(parseApiBody(200, noHeaders, '{"object":"list","data":[]}'), { object: "list", data: [] });
  });

  it("skips the keep-alive newlines of a long response", () => {
    assert.deepEqual(parseApiBody(200, noHeaders, '\n\n\n{"choices":[]}'), { choices: [] });
  });

  it("throws for an error that arrives inside a 200 body", () => {
    const err = caught(() =>
      parseApiBody(
        200,
        new Headers({ "x-request-id": "req_123" }),
        '\n\n\n\n{"error":{"type":"api_error","code":"upstream_error","message":"The request hit the 10-minute time limit."}}',
      ),
    );
    assert.equal(err.status, 200);
    assert.equal(err.code, "upstream_error");
    assert.equal(err.inOkBody, true);
    assert.equal(err.requestId, "req_123");
    assert.equal(err.message, "The request hit the 10-minute time limit.");
  });

  it("reads the OpenAI error shape of an error status", () => {
    const err = caught(() =>
      parseApiBody(
        401,
        noHeaders,
        '{"error":{"type":"authentication_error","code":"invalid_api_key","message":"Missing or invalid API key."}}',
      ),
    );
    assert.equal(err.status, 401);
    assert.equal(err.code, "invalid_api_key");
    assert.equal(err.inOkBody, false);
  });

  it("reads Retry-After", () => {
    const err = caught(() =>
      parseApiBody(
        429,
        new Headers({ "retry-after": "5" }),
        '{"error":{"type":"rate_limit_error","code":"capacity_exhausted","message":"All model replicas are busy. Retry shortly."}}',
      ),
    );
    assert.equal(err.retryAfterSeconds, 5);
  });

  it("handles non-JSON error pages and empty bodies", () => {
    const html = caught(() => parseApiBody(502, noHeaders, "<html>Bad gateway</html>"));
    assert.equal(html.code, null);
    assert.match(html.message, /HTTP 502: <html>Bad gateway<\/html>/);
    assert.match(caught(() => parseApiBody(200, noHeaders, "\n\n")).message, /empty response/);
    assert.match(caught(() => parseApiBody(200, noHeaders, "not json")).message, /isn't JSON/);
    assert.equal(caught(() => parseApiBody(500, noHeaders, '{"unexpected":true}')).message, "HTTP 500");
  });

  it("accepts a string error", () => {
    assert.equal(caught(() => parseApiBody(400, noHeaders, '{"error":"bad"}')).message, "bad");
  });

  it("does not treat a null error member as an error", () => {
    assert.deepEqual(parseApiBody(200, noHeaders, '{"error":null,"ok":1}'), { error: null, ok: 1 });
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("15"), 15);
    const now = Date.parse("2026-11-14T12:00:00Z");
    assert.equal(parseRetryAfter("Sat, 14 Nov 2026 12:00:30 GMT", now), 30);
    assert.equal(parseRetryAfter("soon"), null);
  });
});

describe("describeApiError", () => {
  const error = (init: Partial<ConstructorParameters<typeof ApiError>[0]>) =>
    new ApiError({
      status: 400,
      code: null,
      message: "message",
      retryAfterSeconds: null,
      requestId: null,
      inOkBody: false,
      ...init,
    });

  it("points a 401 at the key configuration", () => {
    const text = describeApiError(error({ status: 401, message: "Missing or invalid API key." }));
    assert.match(text, /invalid_api_key/);
    assert.match(text, /ABLITERATEDLLM_API_KEY/);
    assert.match(text, /abliteratedllm\.dev\/dashboard\/keys/);
  });

  it("explains spend caps in terms of max_tokens", () => {
    const text = describeApiError(error({ status: 402, code: "key_spend_cap_reached" }));
    assert.match(text, /lower max_tokens/);
  });

  it("adds Retry-After and the request id", () => {
    const text = describeApiError(
      error({ status: 429, code: "capacity_exhausted", retryAfterSeconds: 5, requestId: "req_9" }),
    );
    assert.match(text, /Retry after 5 s\./);
    assert.match(text, /Request id: req_9\./);
  });

  it("says when the error came in a 200 body", () => {
    const text = describeApiError(error({ status: 200, code: "upstream_error", inOkBody: true }));
    assert.match(text, /HTTP 200, reported in the response body/);
  });
});
