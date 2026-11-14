#!/usr/bin/env node
// Starts the built server (dist/index.js) over stdio, the way an MCP host does, and calls its tools.
//
//   npm run build && npm run smoke            no key: tools/list, list_models and estimate_cost
//                                             (public catalog), get_balance must refuse cleanly
//   npm run smoke -- --live                   also passes ABLITERATEDLLM_API_KEY to the server and
//                                             runs get_balance and one small chat (spends credit)
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const live = process.argv.includes("--live");
const key = process.env.ABLITERATEDLLM_API_KEY;
if (live && !key) {
  console.error("--live needs ABLITERATEDLLM_API_KEY in the environment.");
  process.exit(1);
}

// getDefaultEnvironment() passes only PATH, HOME and similar, so the key reaches the server only with --live.
const env = getDefaultEnvironment();
if (live) env.ABLITERATEDLLM_API_KEY = key;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  env,
});
const client = new Client({ name: "abliteratedllm-smoke", version: "0.0.0" });

const text = (result) => result.content.map((block) => block.text).join("\n");
const step = (name) => console.log(`\n== ${name}`);

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`connected to ${info?.name} ${info?.version}`);

  step("tools/list");
  const { tools } = await client.listTools();
  console.log(tools.map((t) => `${t.name} (readOnly: ${t.annotations?.readOnlyHint})`).join("\n"));
  assert.deepEqual(tools.map((t) => t.name).sort(), ["chat", "estimate_cost", "get_balance", "list_models"]);

  step("list_models (public catalog, no key)");
  const models = await client.callTool({ name: "list_models", arguments: {} });
  assert.notEqual(models.isError, true, text(models));
  const catalog = models.structuredContent;
  assert.ok(catalog.count > 0, "the catalog is empty");
  for (const m of catalog.models) {
    console.log(`${m.id}  ${m.variant}  ctx ${m.context_length}  out ${m.max_output_tokens}  $${m.pricing.input}/$${m.pricing.output} per 1M`);
  }
  assert.ok(
    catalog.models.some((m) => m.id === "glm-5.3-flash-abliterated"),
    "the default model glm-5.3-flash-abliterated is not in the catalog",
  );

  step("estimate_cost (public catalog, no key)");
  const cost = await client.callTool({
    name: "estimate_cost",
    arguments: { input_tokens: 1000, output_tokens: 2048 },
  });
  assert.notEqual(cost.isError, true, text(cost));
  console.log(JSON.stringify(cost.structuredContent.cost_usd));

  step(`get_balance (${live ? "with key" : "without key: must refuse before any request"})`);
  const balance = await client.callTool({ name: "get_balance", arguments: {} });
  console.log(text(balance));
  if (live) assert.notEqual(balance.isError, true);
  else {
    assert.equal(balance.isError, true);
    assert.match(text(balance), /ABLITERATEDLLM_API_KEY/);
  }

  if (live) {
    step("chat (spends a little credit)");
    const chat = await client.callTool({
      name: "chat",
      arguments: { prompt: "Reply with the single word OK.", max_tokens: 512 },
    });
    console.log(text(chat));
    assert.notEqual(chat.isError, true);
  }

  console.log("\nsmoke test passed");
} catch (err) {
  console.error(`\nsmoke test FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
