import test from "node:test";
import assert from "node:assert/strict";
import { discoverDockerContainers, matchingRepoDigest, repositoryKey } from "../src/docker-target.js";
import type { HttpRequestOptions } from "../src/types.js";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

test("normalizes Docker Hub short names when keying repositories", () => {
  assert.equal(repositoryKey("traefik:v3.1"), "docker.io/library/traefik");
  assert.equal(repositoryKey("docker.io/library/traefik@" + digest("a")), "docker.io/library/traefik");
  assert.equal(repositoryKey("index.docker.io/linuxserver/plex"), "docker.io/linuxserver/plex");
  assert.equal(repositoryKey("ghcr.io/siderolabs/omni:v1.2.0"), "ghcr.io/siderolabs/omni");
  assert.equal(repositoryKey("localhost:5000/app:1"), "localhost:5000/app");
});

test("picks the repo digest that belongs to the running image's repository", () => {
  const digests = [`ghcr.io/other/app@${digest("b")}`, `traefik@${digest("a")}`];
  assert.equal(matchingRepoDigest("docker.io/library/traefik:v3.1", digests), digest("a"));
  assert.equal(matchingRepoDigest("quay.io/traefik/traefik:v3.1", digests), undefined);
  assert.equal(matchingRepoDigest("traefik:v3.1", ["traefik@md5:abc"]), undefined);
});

test("maps compose containers to namespace/pod/container and resolves moved tags and digests", async () => {
  const requests: Array<{ url: string; socketPath?: string }> = [];
  const responses: Record<string, unknown> = {
    "/containers/json": [
      {
        Id: "c1",
        Names: ["/versity-versitygw-1"],
        Image: "versity/versitygw:v1.0.14",
        ImageID: "sha256:img1",
        Labels: { "com.docker.compose.project": "versity", "com.docker.compose.service": "versitygw" },
      },
      // Tag moved to a newer image after this container was created.
      { Id: "c2", Names: ["/standalone"], Image: "sha256:img2", ImageID: "sha256:img2", Labels: null },
      // Built locally: no reference to report.
      { Id: "c3", Names: ["/scratch"], Image: "sha256:img3", ImageID: "sha256:img3", Labels: {} },
    ],
    "/images/sha256%3Aimg1/json": { RepoDigests: [`versity/versitygw@${digest("1")}`] },
    "/images/sha256%3Aimg2/json": { RepoDigests: [`ghcr.io/acme/tool@${digest("2")}`] },
    "/containers/c2/json": { Config: { Image: "ghcr.io/acme/tool:latest" } },
    "/containers/c3/json": { Config: { Image: "sha256:img3" } },
  };

  const results = await discoverDockerContainers({
    endpoint: "unix:///var/run/docker.sock",
    timeoutMs: 1_000,
    requestJson: async (url, options: HttpRequestOptions) => {
      const parsed = new URL(url);
      requests.push({ url: parsed.href, ...(options.socketPath ? { socketPath: options.socketPath } : {}) });
      if (!(parsed.pathname in responses)) throw new Error(`unexpected ${parsed.pathname}`);
      return responses[parsed.pathname];
    },
  });

  assert.deepEqual(results, [
    {
      version: "v1.0.14",
      namespace: "versity",
      pod: "versity-versitygw-1",
      container: "versitygw",
      image: "versity/versitygw:v1.0.14",
      digest: digest("1"),
    },
    {
      version: "latest",
      namespace: "",
      pod: "standalone",
      container: "standalone",
      image: "ghcr.io/acme/tool:latest",
      digest: digest("2"),
    },
  ]);
  assert.ok(requests.every((request) => request.socketPath === "/var/run/docker.sock"));
  assert.ok(requests.every((request) => request.url.startsWith("http://localhost/")));
});

test("talks to an HTTP Docker endpoint such as a socket proxy and tolerates missing images", async () => {
  const urls: string[] = [];
  const results = await discoverDockerContainers({
    endpoint: "http://docker-proxy:2375",
    timeoutMs: 1_000,
    requestJson: async (url, options) => {
      urls.push(String(url));
      assert.equal(options.socketPath, undefined);
      if (String(url).endsWith("/containers/json")) {
        return [{ Id: "c1", Names: ["/app"], Image: "app:1.0", ImageID: "sha256:gone" }];
      }
      throw new Error("No such image");
    },
  });

  assert.deepEqual(results, [{ version: "1.0", namespace: "", pod: "app", container: "app", image: "app:1.0" }]);
  assert.equal(urls[0], "http://docker-proxy:2375/containers/json");
});

test("rejects responses that aren't container lists", async () => {
  await assert.rejects(
    discoverDockerContainers({ endpoint: "http://docker:2375", timeoutMs: 1_000, requestJson: async () => ({}) }),
    /container list/,
  );
});
