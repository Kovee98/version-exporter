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
