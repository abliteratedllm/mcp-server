import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as z from "zod";

const read = (file: string): unknown => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

const PackageJson = z.object({
  name: z.string(),
  version: z.string(),
  mcpName: z.string(),
  bin: z.record(z.string(), z.string()),
});
const ServerJson = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  packages: z.array(
    z.object({
      registryType: z.string(),
      identifier: z.string(),
      version: z.string(),
      environmentVariables: z.array(z.object({ name: z.string(), isRequired: z.boolean(), isSecret: z.boolean() })),
    }),
  ),
});

describe("package.json and server.json", () => {
  const pkg = PackageJson.parse(read("package.json"));
  const server = ServerJson.parse(read("server.json"));
  const [npm] = server.packages;

  it("agree on the registry name, package and version", () => {
    assert.equal(server.name, pkg.mcpName);
    assert.equal(server.version, pkg.version);
    assert.equal(npm?.registryType, "npm");
    assert.equal(npm?.identifier, pkg.name);
    assert.equal(npm?.version, pkg.version);
  });

  it("keep the registry description within 100 characters", () => {
    assert.ok(server.description.length <= 100, `${server.description.length} characters`);
  });

  it("declare the key as an optional secret, since list_models and estimate_cost work without it", () => {
    const key = npm?.environmentVariables.find((v) => v.name === "ABLITERATEDLLM_API_KEY");
    assert.deepEqual(key && { isRequired: key.isRequired, isSecret: key.isSecret }, { isRequired: false, isSecret: true });
  });

  it("has a single bin, so npx runs it by package name", () => {
    assert.deepEqual(Object.values(pkg.bin), ["dist/index.js"]);
  });
});
