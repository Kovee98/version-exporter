import test from "node:test";
import assert from "node:assert/strict";
import { discoverKubernetesImages, imageIdDigest, imageVersion, nodeVersions } from "../src/kubernetes-target.js";
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
              status: {
                containerStatuses: [{ name: "app", imageID: `ghcr.io/team/app@sha256:${"d".repeat(64)}` }],
              },
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
  assert.equal(firstRequest.url.searchParams.get("limit"), "50");
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
  assert.equal(result[0]?.digest, `sha256:${"d".repeat(64)}`);
  assert.equal(result[1]?.digest, undefined);
});

test("fails with a clear error when not running in Kubernetes", async () => {
  await assert.rejects(
    discoverKubernetesImages({ timeoutMs: 1_000, environment: {} }),
    /KUBERNETES_SERVICE_HOST/,
  );
});

test("reads repo digests from container status image IDs", () => {
  const digest = `sha256:${"e".repeat(64)}`;
  assert.equal(imageIdDigest(`docker.io/library/nginx@${digest}`), digest);
  assert.equal(imageIdDigest(digest), undefined);
  assert.equal(imageIdDigest(undefined), undefined);
});

test("reports Talos and kubelet versions for nodes", () => {
  assert.deepEqual(
    nodeVersions({
      metadata: { name: "cp-1" },
      status: { nodeInfo: { osImage: "Talos (v1.14.4)", kubeletVersion: "v1.37.1" } },
    }),
    [
      { version: "v1.14.4", namespace: "", pod: "cp-1", container: "talos", image: "ghcr.io/siderolabs/installer:v1.14.4" },
      { version: "v1.37.1", namespace: "", pod: "cp-1", container: "kubelet", image: "ghcr.io/siderolabs/kubelet:v1.37.1" },
    ],
  );
  assert.deepEqual(
    nodeVersions({ metadata: { name: "w" }, status: { nodeInfo: { osImage: "Ubuntu 24.04", kubeletVersion: "v1.30.2+k3s1" } } }),
    [{ version: "v1.30.2+k3s1", namespace: "", pod: "w", container: "kubelet", image: "registry.k8s.io/kube-apiserver:v1.30.2+k3s1" }],
  );
  assert.deepEqual(nodeVersions({ metadata: { name: "x" } }), []);
});

test("lists nodes only when enabled", async () => {
  const paths: string[] = [];
  const discover = (nodes: boolean) =>
    discoverKubernetesImages({
      timeoutMs: 1_000,
      nodes,
      environment: { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
      read: async () => "token",
      requestJson: async (url) => {
        const { pathname } = new URL(url);
        paths.push(pathname);
        return pathname.endsWith("/nodes")
          ? { items: [{ metadata: { name: "n1" }, status: { nodeInfo: { osImage: "Talos (v1.14.4)", kubeletVersion: "v1.37.1" } } }] }
          : { items: [] };
      },
    });

  assert.equal((await discover(false)).length, 0);
  assert.deepEqual(paths, ["/api/v1/pods"]);
  assert.deepEqual((await discover(true)).map(({ container }) => container), ["talos", "kubelet"]);
  assert.deepEqual(paths, ["/api/v1/pods", "/api/v1/pods", "/api/v1/nodes"]);
});
