import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CatalogCache, type CatalogModel, filterModels, parseCatalog } from "../src/catalog.ts";
import { CATALOG_BODY } from "./fixtures.ts";

describe("parseCatalog", () => {
  const models = parseCatalog(CATALOG_BODY);

  it("keeps valid entries in catalog order and skips malformed ones", () => {
    assert.deepEqual(
      models.map((m) => m.id),
      ["glm-5.3-flash-abliterated", "deepseek-v4.1-flash-1017", "glm-5.3"],
    );
  });

  it("maps the reported fields and keeps prices as strings", () => {
    assert.deepEqual(models[0], {
      id: "glm-5.3-flash-abliterated",
      name: "GLM-5.3 Flash Abliterated",
      variant: "abliterated",
      context_length: 1048576,
      max_output_tokens: 131072,
      pricing: { input: "0.0977", output: "0.3421", cached_input: "0.0098", priority: null },
      input_modalities: ["text", "image"],
      capabilities: { reasoning: true, vision: true, priority_tier: false },
    });
    assert.deepEqual(models[1]?.pricing.priority, { input: "0.3375", output: "1.35", cached_input: "0.00675" });
    assert.equal(models[1]?.capabilities.priority_tier, true);
  });

  it("fills gaps conservatively", () => {
    const [model] = parseCatalog({ data: [{ id: "bare", pricing: { input: "1", output: "2" } }] });
    assert.deepEqual(model, {
      id: "bare",
      name: "bare",
      variant: null,
      context_length: null,
      max_output_tokens: null,
      pricing: { input: "1", output: "2", cached_input: "1", priority: null },
      input_modalities: ["text"],
      capabilities: { reasoning: false, vision: false, priority_tier: false },
    });
  });

  it("rejects a body without a data array", () => {
    assert.throws(() => parseCatalog({ error: "nope" }), /no data array/);
    assert.throws(() => parseCatalog(null), /no data array/);
  });
});

describe("filterModels", () => {
  const models = parseCatalog(CATALOG_BODY);
  const ids = (list: CatalogModel[]) => list.map((m) => m.id);

  it("returns everything without filters", () => {
    assert.equal(filterModels(models, {}).length, 3);
  });

  it("filters by variant", () => {
    assert.deepEqual(ids(filterModels(models, { variant: "abliterated" })), ["glm-5.3-flash-abliterated"]);
    assert.deepEqual(ids(filterModels(models, { variant: "stock" })), ["deepseek-v4.1-flash-1017", "glm-5.3"]);
  });

  it("filters by image input", () => {
    assert.deepEqual(ids(filterModels(models, { vision: false })), ["glm-5.3"]);
    assert.equal(filterModels(models, { vision: true }).length, 2);
  });

  it("filters by output price, inclusive and exact", () => {
    assert.deepEqual(ids(filterModels(models, { max_output_price: 1.08 })), [
      "glm-5.3-flash-abliterated",
      "deepseek-v4.1-flash-1017",
    ]);
    assert.deepEqual(ids(filterModels(models, { max_output_price: 0.3421 })), ["glm-5.3-flash-abliterated"]);
    assert.deepEqual(ids(filterModels(models, { max_output_price: 0.342 })), []);
  });
});

describe("CatalogCache", () => {
  it("reuses a catalog within the TTL and shares one fetch between concurrent callers", async () => {
    let now = 0;
    let loads = 0;
    const cache = new CatalogCache(
      async () => {
        loads++;
        return parseCatalog(CATALOG_BODY);
      },
      { ttlMs: 1000, now: () => now },
    );
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    assert.equal(loads, 1);
    now = 999;
    await cache.get();
    assert.equal(loads, 1);
    now = 1000;
    await cache.get();
    assert.equal(loads, 2);
  });

  it("retries after a failed fetch", async () => {
    let fail = true;
    const cache = new CatalogCache(async () => {
      if (fail) throw new Error("offline");
      return [];
    });
    await assert.rejects(cache.get(), /offline/);
    fail = false;
    assert.deepEqual((await cache.get()).models, []);
  });
});
