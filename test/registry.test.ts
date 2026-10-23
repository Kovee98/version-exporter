import assert from "node:assert/strict";
import test from "node:test";
import {
  LatestVersionResolver,
  listRegistryTags,
  newestMatchingTag,
  parseImageReference,
  parseVersionTag,
} from "../src/registry.js";

test("parses image references with Docker defaults", () => {
  assert.deepEqual(parseImageReference("postgres:16.4"), {
    registry: "docker.io",
    repository: "library/postgres",
    tag: "16.4",
  });
  assert.deepEqual(parseImageReference("grafana/grafana:11.2.0"), {
    registry: "docker.io",
    repository: "grafana/grafana",
    tag: "11.2.0",
  });
  assert.deepEqual(parseImageReference("ghcr.io/kovee98/version-exporter:v0.1.1@sha256:abc"), {
    registry: "ghcr.io",
    repository: "kovee98/version-exporter",
    tag: "v0.1.1",
  });
  assert.deepEqual(parseImageReference("localhost:5000/app:1.0"), {
    registry: "localhost:5000",
    repository: "app",
    tag: "1.0",
  });
  assert.equal(parseImageReference("postgres"), undefined);
  assert.equal(parseImageReference("postgres@sha256:abc"), undefined);
});

test("parses only comparable version tags", () => {
  assert.deepEqual(parseVersionTag("v1.2.3"), { prefix: "v", numbers: [1, 2, 3], suffix: "" });
  assert.deepEqual(parseVersionTag("16.4-alpine"), { prefix: "", numbers: [16, 4], suffix: "-alpine" });
  assert.equal(parseVersionTag("latest"), undefined);
  assert.equal(parseVersionTag("1.2.3-rc1"), undefined);
  assert.equal(parseVersionTag("1.41.3-ls270"), undefined);
});

test("picks the newest tag with the same shape", () => {
  const tags = ["16.3-alpine", "16.4-alpine", "17.0-alpine", "17.1", "17-alpine", "18.0-rc1-alpine", "latest"];
  assert.equal(newestMatchingTag("16.4-alpine", tags), "17.0-alpine");
  assert.equal(newestMatchingTag("v1.2.3", ["v1.10.0", "1.11.0", "v1.9.9"]), "v1.10.0");
  assert.equal(newestMatchingTag("2.0.0", ["1.9.0"]), "2.0.0");
  assert.equal(newestMatchingTag("latest", tags), undefined);
});

test("lists registry tags with anonymous bearer auth and pagination", async (context) => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  context.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init.headers).get("authorization");
    calls.push({ url, authorization });
    if (url.startsWith("https://auth.example/token")) {
      return Response.json({ token: "abc" });
    }
    if (!authorization) {
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="reg",scope="repository:app:pull"' },
      });
    }
    if (url.includes("last=")) {
      return Response.json({ tags: ["1.1"] });
    }
    return Response.json({ tags: ["1.0"] }, { headers: { link: '</v2/app/tags/list?n=1000&last=1.0>; rel="next"' } });
  });

  assert.deepEqual(await listRegistryTags("registry.example", "app", 1_000), ["1.0", "1.1"]);
  assert.equal(calls[1]?.url, "https://auth.example/token?service=reg&scope=repository%3Aapp%3Apull");
  assert.equal(calls[2]?.authorization, "Bearer abc");
  assert.equal(calls[3]?.url, "https://registry.example/v2/app/tags/list?n=1000&last=1.0");
});

test("resolver caches lookups per repository and tolerates failures", async () => {
  const lookups: string[] = [];
  let now = 0;
  const resolver = new LatestVersionResolver({
    ttlMs: 1_000,
    timeoutMs: 1_000,
    now: () => now,
    logger: { error: () => {} },
    listTags: async (registry, repository) => {
      lookups.push(`${registry}/${repository}`);
      if (repository === "library/broken") throw new Error("boom");
      return ["1.0", "1.1", "2.0-alpine"];
    },
  });

  const images = ["app:1.0", "app:1.0-alpine", "broken:1.0", "app:latest"];
  const first = await resolver.resolve(images);
  assert.deepEqual(Object.fromEntries(first.latest), { "app:1.0": "1.1", "app:1.0-alpine": "2.0-alpine" });
  assert.equal(first.lookups, 2);
  assert.equal(first.failures, 1);
  assert.deepEqual(lookups.sort(), ["docker.io/library/app", "docker.io/library/broken"]);

  now = 500;
  assert.equal((await resolver.resolve(images)).lookups, 0);
  now = 1_500;
  assert.equal((await resolver.resolve(images)).lookups, 2);
});
