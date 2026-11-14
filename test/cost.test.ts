import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCost } from "../src/cost.ts";
import { fromScaled, toScaled } from "../src/decimal.ts";

const GLM_FLASH_ABLITERATED = { input: "0.0977", output: "0.3421", cached_input: "0.0098" };

describe("decimal", () => {
  it("scales decimal strings exactly", () => {
    assert.equal(toScaled("0.0977", 6), 97_700n);
    assert.equal(toScaled("12", 2), 1200n);
    assert.equal(toScaled("0.10000", 2), 10n);
  });

  it("rejects malformed values and lost precision", () => {
    assert.throws(() => toScaled("-1", 6));
    assert.throws(() => toScaled("1e-3", 6));
    assert.throws(() => toScaled("", 6));
    assert.throws(() => toScaled("0.1234567", 6), /more than 6 decimals/);
  });

  it("formats with a minimum number of decimals", () => {
    assert.equal(fromScaled(97_700n, 6, 6), "0.097700");
    assert.equal(fromScaled(97_700n, 6), "0.0977");
    assert.equal(fromScaled(5n, 18, 6), "0.000000000000000005");
    assert.equal(fromScaled(0n, 6, 6), "0.000000");
    assert.equal(fromScaled(1_000_000n, 6), "1");
  });
});

describe("estimateCost", () => {
  it("applies the billing formula and rounds the total up to $0.000001", () => {
    // 31 × 0.0977 / 1e6 + 212 × 0.3421 / 1e6 = 0.0000755539 → 0.000076
    assert.deepEqual(
      estimateCost(GLM_FLASH_ABLITERATED, { input_tokens: 31, cached_input_tokens: 0, output_tokens: 212 }),
      { uncached_input: "0.0000030287", cached_input: "0.000000", output: "0.0000725252", total: "0.000076" },
    );
  });

  it("bills cached tokens at the cached-input price", () => {
    // 1M input of which 600k cached: 400k × 0.0977 + 600k × 0.0098 = 0.03908 + 0.00588
    const cost = estimateCost(GLM_FLASH_ABLITERATED, {
      input_tokens: 1_000_000,
      cached_input_tokens: 600_000,
      output_tokens: 0,
    });
    assert.equal(cost.uncached_input, "0.039080");
    assert.equal(cost.cached_input, "0.005880");
    assert.equal(cost.total, "0.044960");
  });

  it("is exact where floats are not", () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; in decimals it is 0.3.
    const cost = estimateCost(
      { input: "0.1", output: "0.2", cached_input: "0" },
      { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 1_000_000 },
    );
    assert.equal(cost.total, "0.300000");
  });

  it("returns zero for zero tokens", () => {
    const cost = estimateCost(GLM_FLASH_ABLITERATED, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
    assert.equal(cost.total, "0.000000");
  });

  it("rejects impossible token counts", () => {
    assert.throws(
      () => estimateCost(GLM_FLASH_ABLITERATED, { input_tokens: 10, cached_input_tokens: 11, output_tokens: 0 }),
      /cached_input_tokens/,
    );
    assert.throws(
      () => estimateCost(GLM_FLASH_ABLITERATED, { input_tokens: -1, cached_input_tokens: 0, output_tokens: 0 }),
      /input_tokens/,
    );
    assert.throws(
      () => estimateCost(GLM_FLASH_ABLITERATED, { input_tokens: 1.5, cached_input_tokens: 0, output_tokens: 0 }),
      /input_tokens/,
    );
  });
});
