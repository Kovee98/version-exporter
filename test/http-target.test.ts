import test from "node:test";
import assert from "node:assert/strict";
import { scrapeHttpTarget } from "../src/http-target.js";
import type { HttpTarget } from "../src/types.js";

const target: HttpTarget = {
  name: "example",
  label: "Example",
  type: "http",
  url: "https://example.com/version",
  jsonpath: "$.release.version",
  metricName: "version_exporter_example_version",
  group: "default",
  every: "1h",
  timeout: "10s",
  retries: 0,
  backoff: "1s",
};

test("extracts a single JSONPath version", async () => {
  const versions = await scrapeHttpTarget(target, {
    timeoutMs: 1_000,
    requestJson: async () => ({ release: { version: "1.2.3" } }),
  });
  assert.deepEqual(versions, [
    {
      version: "1.2.3",
      namespace: "",
      pod: "",
      container: "",
      image: "",
    },
  ]);
});

test("rejects JSONPath expressions that produce zero or multiple results", async () => {
  for (const [json, path, count] of [
    [{ release: {} }, "$.release.version", 0],
    [{ versions: ["1.0", "2.0"] }, "$.versions[*]", 2],
  ] as Array<[object, string, number]>) {
    await assert.rejects(
      scrapeHttpTarget({ ...target, jsonpath: path }, {
        timeoutMs: 1_000,
        requestJson: async () => json,
      }),
      new RegExp(`returned ${count} values`),
    );
  }
});

test("rejects non-scalar and empty versions", async () => {
  for (const version of [null, {}, "", "  "] as Array<null | object | string>) {
    await assert.rejects(
      scrapeHttpTarget(target, {
        timeoutMs: 1_000,
        requestJson: async () => ({ release: { version } }),
      }),
      /non-empty string or number/,
    );
  }
});
