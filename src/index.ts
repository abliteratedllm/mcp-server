#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient, QUICK_TIMEOUT_MS } from "./api.ts";
import { CatalogCache, parseCatalog } from "./catalog.ts";
import { readConfig } from "./config.ts";
import { createServer } from "./server.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const api = new ApiClient({ apiKey: config.apiKey, userAgent: `abliteratedllm-mcp-server/${version}` });
  // The catalog is shared by every tool call, so its fetch has its own timeout rather than a caller's signal.
  const catalog = new CatalogCache(async () => parseCatalog(await api.listModels(AbortSignal.timeout(QUICK_TIMEOUT_MS))));
  const server = createServer({ api, catalog, config, version });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr.
  console.error(
    `AbliteratedLLM MCP server ${version} on stdio. API key ${config.apiKey ? "set" : "not set (chat and get_balance are unavailable)"}; chat timeout ${config.chatTimeoutMs / 1000} s.`,
  );
}

main().catch((err: unknown) => {
  console.error(`abliteratedllm-mcp-server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
