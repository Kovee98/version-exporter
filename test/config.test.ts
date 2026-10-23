import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";

const baseConfig = {
  targets: [
    {
      name: "Home-API",
      label: "Home API",
      type: "http",
      url: "https://example.com/version",
      jsonpath: "$.version",
    },
  ],
};

test("applies defaults and normalizes metric names", () => {
  const config = validateConfig(baseConfig);
  assert.equal(config.targets[0].metricName, "version_exporter_home_api_version");
  assert.equal(config.targets[0].every, "1m");
  assert.equal(config.targets[0].timeout, "10s");
  assert.equal(config.targets[0].group, "default");
});

test("rejects unsupported URL protocols", () => {
  assert.throws(
    () => validateConfig({ targets: [{ ...baseConfig.targets[0], url: "file:///etc/passwd" }] }),
    /must use HTTP or HTTPS/,
  );
});

test("rejects credentials embedded in target URLs", () => {
  assert.throws(
    () =>
      validateConfig({
        targets: [{ ...baseConfig.targets[0], url: "https://user:password@example.com/version" }],
      }),
    /must not contain embedded credentials/,
  );
});

test("rejects metric-name collisions", () => {
  assert.throws(
    () =>
      validateConfig({
        targets: [
          ...baseConfig.targets,
          { ...baseConfig.targets[0], name: "home_api" },
        ],
      }),
    /collides/,
  );
});

test("requires HTTP fields and prevents HTTP-only fields on Kubernetes targets", () => {
  assert.throws(() => validateConfig({ targets: [{ name: "api", label: "API", type: "http" }] }));
  assert.throws(
    () =>
      validateConfig({
        targets: [{ name: "pods", label: "Pods", type: "kubernetes", url: "https://example.com" }],
      }),
  );
});

test("requires groups referenced by targets", () => {
  assert.throws(
    () => validateConfig({ targets: [{ ...baseConfig.targets[0], group: "missing" }] }),
    /unknown group/,
  );
});

test("applies latest-lookup defaults to Kubernetes targets and rejects invalid options", () => {
  const kubernetes = { name: "images", label: "Images", type: "kubernetes" };
  const config = validateConfig({ targets: [{ ...kubernetes, latest: {} }] });
  assert.deepEqual((config.targets[0] as { latest?: unknown }).latest, {
    every: "6h",
    concurrency: 4,
    exclude: [],
    ignoreTags: [],
    upstreams: [],
    checkDigests: "all",
  });
  assert.equal((validateConfig({ targets: [kubernetes] }).targets[0] as { nodes?: boolean }).nodes, false);
  assert.equal((validateConfig({ targets: [{ ...kubernetes, nodes: true }] }).targets[0] as { nodes?: boolean }).nodes, true);
  assert.throws(() => validateConfig({ targets: [{ ...baseConfig.targets[0], nodes: true }] }), /Invalid configuration/);
  assert.throws(() => validateConfig({ targets: [{ ...kubernetes, latest: { checkDigests: "some" } }] }), /Invalid configuration/);
  assert.equal("latest" in validateConfig({ targets: [kubernetes] }).targets[0], false);
  assert.throws(() => validateConfig({ targets: [{ ...baseConfig.targets[0], latest: {} }] }), /Invalid configuration/);
  assert.throws(
    () => validateConfig({ targets: [{ ...kubernetes, latest: { exclude: ["("] } }] }),
    /invalid latest.exclude pattern/,
  );
  assert.throws(
    () => validateConfig({ targets: [{ ...kubernetes, latest: { upstreams: [{ match: "(", repository: "a/b" }] } }] }),
    /invalid latest.upstreams pattern/,
  );
  assert.throws(
    () => validateConfig({ targets: [{ ...kubernetes, latest: { upstreams: [{ match: "x", repository: "a/b:1" }] } }] }),
    /must not include a tag/,
  );
  assert.equal(
    (validateConfig({ targets: [{ ...kubernetes, latest: { upstreams: [{ match: "x", repository: "localhost:5000/a" }] } }] })
      .targets[0] as { latest?: { upstreams: unknown[] } }).latest?.upstreams.length,
    1,
  );
});

test("applies system, Docker endpoint and push defaults and validates them", () => {
  const docker = { name: "containers", label: "Containers", type: "docker" };
  const config = validateConfig({
    defaults: { system: "odin" },
    push: { url: "https://vm.example.com/api/v1/import/prometheus" },
    targets: [docker, { ...docker, name: "remote", system: "fenrir", endpoint: "http://proxy:2375", latest: {} }],
  });
  assert.equal(config.targets[0].system, "odin");
  assert.equal((config.targets[0] as { endpoint?: string }).endpoint, "unix:///var/run/docker.sock");
  assert.equal(config.targets[1].system, "fenrir");
  assert.deepEqual(config.push, { url: "https://vm.example.com/api/v1/import/prometheus", every: "1m", timeout: "10s" });
  assert.equal(typeof validateConfig(baseConfig).targets[0].system, "string");

  assert.throws(() => validateConfig({ targets: [{ ...docker, url: "https://example.com" }] }), /Invalid configuration/);
  assert.throws(() => validateConfig({ targets: [{ ...docker, endpoint: "tcp://proxy:2375" }] }), /unix, HTTP or HTTPS/);
  assert.throws(
    () => validateConfig({ targets: [{ name: "pods", label: "Pods", type: "kubernetes", endpoint: "unix:///x" }] }),
    /Invalid configuration/,
  );
  assert.throws(() => validateConfig({ ...baseConfig, push: { url: "ftp://vm" } }), /push.url must use HTTP or HTTPS/);
});
