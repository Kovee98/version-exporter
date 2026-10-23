import assert from "node:assert/strict";
import test from "node:test";
import {
  LatestVersionResolver,
  listRegistryTags,
  lookupManifestDigest,
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

test("reduces tags to a comparable shape", () => {
  assert.deepEqual(parseVersionTag("v1.2.3"), { shape: "v#.#.#", prefix: "v", numbers: [1, 2, 3] });
  assert.deepEqual(parseVersionTag("16.4-alpine"), { shape: "#.#-alpine", prefix: "", numbers: [16, 4] });
  assert.deepEqual(parseVersionTag("1.41.3-ls270"), { shape: "#.#.#-ls#", prefix: "", numbers: [1, 41, 3, 270] });
  assert.deepEqual(parseVersionTag("2024.10.22-7ca5933"), { shape: "#.#.#-*", prefix: "", numbers: [2024, 10, 22] });
  assert.deepEqual(parseVersionTag("config-reloader-v0.75.0"), {
    shape: "config-reloader-v#.#.#",
    prefix: "config-reloader-v",
    numbers: [0, 75, 0],
  });
  assert.equal(parseVersionTag("v1.36.9-1782267392-edeb3f2af56c37c407efa1f63f0b32f595399bbc")?.shape, "v#.#.#-#-*");
  assert.equal(parseVersionTag("latest"), undefined);
  assert.equal(parseVersionTag("preview-pgsql-starvation-fix"), undefined);
});

test("picks the newest tag with the same shape", () => {
  const tags = ["16.3-alpine", "16.4-alpine", "17.0-alpine", "17.1", "17-alpine", "18.0-rc1-alpine", "latest"];
  assert.equal(newestMatchingTag("16.4-alpine", tags), "17.0-alpine");
  assert.equal(newestMatchingTag("v1.2.3", ["v1.10.0", "1.11.0", "v1.9.9", "v1.12.0-rc1"]), "v1.10.0");
  assert.equal(newestMatchingTag("2.0.0", ["1.9.0"]), "2.0.0");
  assert.equal(newestMatchingTag("latest", tags), undefined);
  assert.equal(
    newestMatchingTag("2024.5.13-a0bc346", ["2024.10.22-7ca5933", "2023.8.21-6f93cba", "nightly"]),
    "2024.10.22-7ca5933",
  );
  assert.equal(
    newestMatchingTag("16.9-0.4.3", ["16.9-0.5.2", "16.9", "17.5-0.5.2-rc1"]),
    "16.9-0.5.2",
  );
  assert.equal(
    newestMatchingTag("5.2.4", ["5.3.0", "20.04.1", "14.3.9"], (tag) => /^(20\.04\.1|14\.3\.9)$/.test(tag)),
    "5.3.0",
  );
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

test("looks up manifest digests with a HEAD request", async (context) => {
  const calls: Array<{ url: string; method: string | undefined; accept: string | null }> = [];
  context.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    calls.push({ url: String(input), method: init.method, accept: new Headers(init.headers).get("accept") });
    return new Response(null, { headers: { "docker-content-digest": `sha256:${"a".repeat(64)}` } });
  });

  assert.equal(await lookupManifestDigest("docker.io", "library/app", "latest", 1_000), `sha256:${"a".repeat(64)}`);
  assert.equal(calls[0]?.url, "https://registry-1.docker.io/v2/library/app/manifests/latest");
  assert.equal(calls[0]?.method, "HEAD");
  assert.match(calls[0]?.accept ?? "", /oci\.image\.index/);
});

test("resolver compares floating tags by digest", async () => {
  const running = `sha256:${"1".repeat(64)}`;
  const remote = `sha256:${"2".repeat(64)}`;
  const resolver = new LatestVersionResolver({
    ttlMs: 1_000,
    timeoutMs: 1_000,
    listTags: async () => [],
    lookupDigest: async (_registry, repository) => (repository === "library/fresh" ? running : remote),
  });

  const result = await resolver.resolve([
    { image: "fresh:latest", digest: running },
    { image: "stale:preview-fix", digest: running },
    { image: "nodigest:latest" },
  ]);
  assert.deepEqual(Object.fromEntries(result.latest), {
    "fresh:latest": "latest",
    "stale:preview-fix": `preview-fix@sha256:${"2".repeat(12)}`,
  });
  assert.equal(result.lookups, 2);
});

test("resolver lists from the tag prefix and falls back when the registry ignores it", async () => {
  const calls: Array<string | undefined> = [];
  const resolver = new LatestVersionResolver({
    ttlMs: 1_000,
    timeoutMs: 1_000,
    ignoreTags: [/^docker\.io\/library\/app:v9\.0\.0$/],
    listTags: async (_registry, repository, _timeout, last) => {
      calls.push(`${repository}:${last ?? ""}`);
      if (repository === "library/ghcr-like" && last) return [];
      return ["v1.0.0", "v1.2.0", "v9.0.0", "abc1234def"];
    },
  });

  const result = await resolver.resolve(["app:v1.0.0", "ghcr-like:v1.0.0"]);
  assert.deepEqual(Object.fromEntries(result.latest), { "app:v1.0.0": "v1.2.0", "ghcr-like:v1.0.0": "v9.0.0" });
  assert.deepEqual(calls.sort(), ["library/app:v", "library/ghcr-like:", "library/ghcr-like:v"]);
});

test("resolver stops sending `last` to registries that ignore it", async () => {
  const calls: string[] = [];
  let now = 0;
  const resolver = new LatestVersionResolver({
    ttlMs: 1_000,
    timeoutMs: 1_000,
    now: () => now,
    listTags: async (_registry, repository, _timeout, last) => {
      calls.push(`${repository}:${last ?? ""}`);
      return last ? [] : ["v1.0.0", "v1.1.0"];
    },
  });

  await resolver.resolve(["ghcr.io/a/one:v1.0.0"]);
  now = 2_000;
  const result = await resolver.resolve(["ghcr.io/a/two:v1.0.0"]);
  assert.equal(result.latest.get("ghcr.io/a/two:v1.0.0"), "v1.1.0");
  assert.deepEqual(calls, ["a/one:v", "a/one:", "a/two:"]);
});

test("retries rate-limited registry requests", async (context) => {
  let attempts = 0;
  context.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    if (attempts === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
    return Response.json({ tags: ["1.0"] });
  });

  assert.deepEqual(await listRegistryTags("registry.example", "app", 1_000), ["1.0"]);
  assert.equal(attempts, 2);
});

test("resolver retries failed lookups before the success TTL expires", async () => {
  let now = 0;
  let calls = 0;
  const resolver = new LatestVersionResolver({
    ttlMs: 6 * 60 * 60_000,
    timeoutMs: 1_000,
    now: () => now,
    logger: { error: () => {} },
    listTags: async () => {
      calls += 1;
      if (calls === 1) throw new Error("429");
      return ["1.0", "1.1"];
    },
  });

  assert.equal((await resolver.resolve(["app:1.0"])).latest.size, 0);
  now = 5 * 60_000;
  assert.equal((await resolver.resolve(["app:1.0"])).lookups, 0);
  now = 11 * 60_000;
  assert.equal((await resolver.resolve(["app:1.0"])).latest.get("app:1.0"), "1.1");
  now = 60 * 60_000;
  assert.equal((await resolver.resolve(["app:1.0"])).lookups, 0);
});

test("resolver looks up upstream repositories for mapped images and compares tags only", async () => {
  const listed: string[] = [];
  let digestLookups = 0;
  const resolver = new LatestVersionResolver({
    ttlMs: 60_000,
    timeoutMs: 1_000,
    upstreams: [{ match: /^192\.168\.1\.21:5000\/homelab\/gha-runner:/, repository: "myoung34/github-runner" }],
    listTags: async (registry, repository) => {
      listed.push(`${registry}/${repository}`);
      return ["2.337.0", "2.338.1", "latest"];
    },
    lookupDigest: async () => {
      digestLookups += 1;
      return `sha256:${"f".repeat(64)}`;
    },
  });

  const { latest } = await resolver.resolve([
    { image: "192.168.1.21:5000/homelab/gha-runner:2.337.0", digest: `sha256:${"a".repeat(64)}` },
  ]);
  assert.equal(latest.get("192.168.1.21:5000/homelab/gha-runner:2.337.0"), "2.338.1");
  assert.deepEqual(listed, ["docker.io/myoung34/github-runner"]);
  assert.equal(digestLookups, 0);
});

test("resolver compares the newest version tag by digest when checkDigests is all", async () => {
  const running = `sha256:${"1".repeat(64)}`;
  const remote = `sha256:${"2".repeat(64)}`;
  const lookups: string[] = [];
  const options = {
    ttlMs: 1_000,
    timeoutMs: 1_000,
    listTags: async () => ["1.0.0", "1.1.0"],
    lookupDigest: async (_registry: string, repository: string, tag: string) => {
      lookups.push(`${repository}:${tag}`);
      return repository === "library/fresh" ? running : remote;
    },
  };
  const images = [
    { image: "fresh:1.1.0", digest: running },
    { image: "rebuilt:1.1.0", digest: running },
    { image: "older:1.0.0", digest: running },
    { image: "nodigest:1.1.0" },
  ];

  const all = await new LatestVersionResolver({ ...options, checkDigests: "all" }).resolve(images);
  assert.deepEqual(Object.fromEntries(all.latest), {
    "fresh:1.1.0": "1.1.0",
    "rebuilt:1.1.0": `1.1.0@sha256:${"2".repeat(12)}`,
    "older:1.0.0": "1.1.0",
    "nodigest:1.1.0": "1.1.0",
  });
  assert.deepEqual(lookups.sort(), ["library/fresh:1.1.0", "library/rebuilt:1.1.0"]);

  lookups.length = 0;
  const floating = await new LatestVersionResolver({ ...options, checkDigests: "floating" }).resolve(images);
  assert.equal(floating.latest.get("rebuilt:1.1.0"), "1.1.0");
  assert.deepEqual(lookups, []);
});

test("resolver keeps the tag result when the digest check fails", async () => {
  const resolver = new LatestVersionResolver({
    ttlMs: 1_000,
    timeoutMs: 1_000,
    checkDigests: "all",
    listTags: async () => ["1.1.0"],
    lookupDigest: async () => {
      throw new Error("boom");
    },
    logger: { error() {} },
  });
  const result = await resolver.resolve([{ image: "app:1.1.0", digest: `sha256:${"1".repeat(64)}` }]);
  assert.equal(result.latest.get("app:1.1.0"), "1.1.0");
  assert.equal(result.failures, 1);
});
