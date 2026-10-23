import test from "node:test";
import assert from "node:assert/strict";
import { discoverKubernetesImages, imageVersion } from "../src/kubernetes-target.js";
import type { HttpRequestOptions } from "../src/types.js";

test("extracts image tags without confusing registry ports or digests", () => {
  assert.equal(imageVersion("ghcr.io/team/app:v1.2.3"), "v1.2.3");
  assert.equal(imageVersion("registry.example:5000/team/app:stable"), "stable");
  assert.equal(imageVersion("ghcr.io/team/app@sha256:abcdef"), "latest");
  assert.equal(imageVersion("ghcr.io/team/app"), "latest");
});

test("discovers images from all paginated Kubernetes pod results", async () => {
  const requests: Array<{ url: URL; options: HttpRequestOptions }> = [];
  const result = await discoverKubernetesImages({
    timeoutMs: 1_000,
    environment: {
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBERNETES_SERVICE_PORT: "443",
      KUBERNETES_SERVICE_ACCOUNT_DIR: "/service-account",
    },
    read: async (file) => (file.endsWith("/token") ? "token\n" : Buffer.from("ca")),
    requestJson: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) {
        return {
          metadata: { continue: "page-2" },
          items: [
            {
              metadata: { namespace: "prod", name: "app-1" },
              spec: { containers: [{ name: "app", image: "ghcr.io/team/app:v1" }] },
            },
          ],
        };
      }
      return {
        metadata: {},
        items: [
          {
            metadata: { namespace: "prod", name: "app-2" },
            spec: { initContainers: [{ name: "init", image: "busybox:1.36" }] },
          },
        ],
      };
    },
  });

  assert.equal(requests.length, 2);
  const firstRequest = requests[0];
  const secondRequest = requests[1];
  assert.ok(firstRequest);
  assert.ok(secondRequest);
  assert.equal(firstRequest.options.headers?.authorization, "Bearer token");
  assert.equal(secondRequest.url.searchParams.get("continue"), "page-2");
  assert.deepEqual(result.map(({ namespace, pod, container, version }) => ({
    namespace,
    pod,
    container,
    version,
  })), [
    { namespace: "prod", pod: "app-1", container: "app", version: "v1" },
    { namespace: "prod", pod: "app-2", container: "init", version: "1.36" },
  ]);
});

test("fails with a clear error when not running in Kubernetes", async () => {
  await assert.rejects(
    discoverKubernetesImages({ timeoutMs: 1_000, environment: {} }),
    /KUBERNETES_SERVICE_HOST/,
  );
});
