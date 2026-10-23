import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";
import { VersionExporter } from "../src/exporter.js";
import type { ExporterMetrics } from "../src/metrics.js";

const config = (overrides: Record<string, unknown> = {}) =>
  validateConfig({
    defaults: { system: "lab", every: "1h", retries: 0 },
    targets: [
      {
        name: "service",
        label: "Service",
        type: "http",
        url: "https://example.com/version",
        jsonpath: "$.version",
        ...overrides,
      },
    ],
  });

async function waitForMetrics(exporter: { metrics: ExporterMetrics }, text: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const metrics = await exporter.metrics.registry.metrics();
    if (metrics.includes(text)) return metrics;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for metric text: ${text}`);
}

test("schedules HTTP targets and publishes their versions", async () => {
  const exporter = new VersionExporter(config(), {
    requestJson: async () => ({ version: "2.4.6" }),
  });
  exporter.start();

  try {
    const metrics = await waitForMetrics(exporter, 'version="2.4.6"');
    assert.match(metrics, /version_exporter_service_version/);
    assert.match(metrics, /version_exporter_target_up\{target="service",system="lab"\} 1/);
  } finally {
    await exporter.stop();
  }
});

test("retries failed scrapes and reports errors", async () => {
  let attempts = 0;
  const errors: string[] = [];
  const exporter = new VersionExporter(
    config({ retries: 1, backoff: "1ms" }),
    {
      requestJson: async () => {
        attempts += 1;
        throw new Error("upstream unavailable");
      },
      logger: { error: (message) => errors.push(message) },
    },
  );
  exporter.start();

  try {
    const metrics = await waitForMetrics(exporter, 'result="error"');
    assert.equal(attempts, 2);
    assert.match(metrics, /version_exporter_target_up\{target="service",system="lab"\} 0/);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /upstream unavailable/);
  } finally {
    await exporter.stop();
  }
});

test("publishes newest registry versions for Kubernetes images", async () => {
  const exporter = new VersionExporter(
    validateConfig({
      defaults: { system: "lab", every: "1h", retries: 0 },
      targets: [{ name: "images", label: "Images", type: "kubernetes", latest: { exclude: ["^skip:"] } }],
    }),
    {
      discoverImages: async () => [
        { version: "1.0", namespace: "prod", pod: "app-1", container: "app", image: "app:1.0" },
        { version: "1.0", namespace: "prod", pod: "skip-1", container: "skip", image: "skip:1.0" },
      ],
      listTags: async () => ["1.0", "1.2"],
    },
  );
  exporter.start();

  try {
    const metrics = await waitForMetrics(exporter, "version_exporter_image_latest{");
    assert.match(metrics, /version_exporter_image_latest\{target="images",system="lab",image="app:1.0",latest_version="1.2"\} 1/);
    assert.doesNotMatch(metrics, /image="skip:1.0",latest_version/);
    assert.match(metrics, /version_exporter_latest_lookups_total\{target="images",system="lab",result="success"\} 1/);
  } finally {
    await exporter.stop();
  }
});

test("publishes Docker containers with their system label and latest versions", async () => {
  const exporter = new VersionExporter(
    validateConfig({
      defaults: { system: "lab", every: "1h", retries: 0 },
      targets: [{ name: "containers", label: "Containers", type: "docker", system: "odin", latest: {} }],
    }),
    {
      discoverContainers: async ({ endpoint }) => {
        assert.equal(endpoint, "unix:///var/run/docker.sock");
        return [{ version: "1.0", namespace: "app", pod: "app-web-1", container: "web", image: "app:1.0" }];
      },
      listTags: async () => ["1.0", "1.1"],
    },
  );
  exporter.start();

  try {
    const metrics = await waitForMetrics(exporter, "version_exporter_image_latest{");
    assert.match(
      metrics,
      /version_exporter_containers_version\{system="odin",label="Containers",version="1.0",namespace="app",pod="app-web-1",container="web",image="app:1.0"\} 1/,
    );
    assert.match(metrics, /version_exporter_image_latest\{target="containers",system="odin",image="app:1.0",latest_version="1.1"\} 1/);
  } finally {
    await exporter.stop();
  }
});

test("pushes rendered metrics to push.url and counts outcomes", async () => {
  const posts: Array<{ url: string; body: string }> = [];
  let fail = false;
  const exporter = new VersionExporter(
    validateConfig({
      defaults: { system: "lab", every: "1h", retries: 0 },
      push: { url: "https://vm.example.com/api/v1/import/prometheus" },
      targets: [{ name: "service", label: "Service", type: "http", url: "https://example.com/v", jsonpath: "$.v" }],
    }),
    {
      requestJson: async () => ({ v: "3.0" }),
      postText: async (url, body) => {
        if (fail) throw new Error("unreachable");
        posts.push({ url: String(url), body });
      },
      logger: { error: () => {} },
    },
  );
  exporter.start();

  try {
    await waitForMetrics(exporter, 'version="3.0"');
    await exporter.pushMetrics();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://vm.example.com/api/v1/import/prometheus");
    assert.match(posts[0].body, /version_exporter_service_version\{system="lab",[^}]*version="3.0"/);
    fail = true;
    await exporter.pushMetrics();
    const metrics = await exporter.metrics.registry.metrics();
    assert.match(metrics, /version_exporter_pushes_total\{system="lab",result="success"\} 1/);
    assert.match(metrics, /version_exporter_pushes_total\{system="lab",result="error"\} 1/);
  } finally {
    await exporter.stop();
  }
});
