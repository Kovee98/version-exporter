import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";
import { ExporterMetrics } from "../src/metrics.js";

test("exposes target version and scrape-health metrics", async () => {
  const config = validateConfig({
    targets: [
      {
        name: "service",
        label: "Service",
        type: "http",
        url: "https://example.com/version",
        jsonpath: "$.version",
      },
    ],
  });
  const metrics = new ExporterMetrics(config.targets);
  const target = config.targets[0];

  metrics.recordScrape(target, {
    success: true,
    versions: [
      {
        version: "1.2.3",
        namespace: "",
        pod: "",
        container: "",
        image: "",
      },
    ],
    durationSeconds: 0.25,
  });
  metrics.recordScrape(target, {
    success: false,
    durationSeconds: 1,
  });

  const output = await metrics.registry.metrics();
  assert.match(output, /version_exporter_service_version\{[^}]*version="1\.2\.3"[^}]*\} 1/);
  assert.match(output, /version_exporter_target_up\{target="service"\} 0/);
  assert.match(output, /version_exporter_target_scrapes_total\{target="service",result="success"\} 1/);
  assert.match(output, /version_exporter_target_scrapes_total\{target="service",result="error"\} 1/);
});
