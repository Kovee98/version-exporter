import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { ConfiguredTarget, VersionResult } from "./types.js";

const VERSION_LABELS = ["label", "version", "namespace", "pod", "container", "image"];

export class ExporterMetrics {
  readonly registry: Registry;
  private readonly targetMetrics: Map<string, Gauge<string>>;
  private readonly targetUp: Gauge<string>;
  private readonly lastScrape: Gauge<string>;
  private readonly scrapeDuration: Gauge<string>;
  private readonly scrapes: Counter<string>;

  constructor(targets: ConfiguredTarget[]) {
    this.registry = new Registry();
    this.targetMetrics = new Map();
    this.targetUp = new Gauge({
      name: "version_exporter_target_up",
      help: "Whether the most recent target scrape succeeded.",
      labelNames: ["target"],
      registers: [this.registry],
    });
    this.lastScrape = new Gauge({
      name: "version_exporter_target_last_scrape_timestamp_seconds",
      help: "Unix timestamp of the most recent target scrape.",
      labelNames: ["target"],
      registers: [this.registry],
    });
    this.scrapeDuration = new Gauge({
      name: "version_exporter_target_scrape_duration_seconds",
      help: "Duration of the most recent target scrape in seconds.",
      labelNames: ["target"],
      registers: [this.registry],
    });
    this.scrapes = new Counter({
      name: "version_exporter_target_scrapes_total",
      help: "Number of target scrapes by outcome.",
      labelNames: ["target", "result"],
      registers: [this.registry],
    });

    for (const target of targets) {
      this.targetMetrics.set(
        target.name,
        new Gauge({
          name: target.metricName,
          help: `Current version reported by target "${target.name}".`,
          labelNames: VERSION_LABELS,
          registers: [this.registry],
        }),
      );
    }
  }

  recordScrape(
    target: ConfiguredTarget,
    {
      success,
      versions = [],
      durationSeconds,
    }: { success: boolean; versions?: VersionResult[]; durationSeconds: number },
  ): void {
    const labels = { target: target.name };
    this.targetUp.set(labels, success ? 1 : 0);
    this.lastScrape.set(labels, Date.now() / 1_000);
    this.scrapeDuration.set(labels, durationSeconds);
    this.scrapes.inc({ ...labels, result: success ? "success" : "error" });

    if (success) {
      const metric = this.targetMetrics.get(target.name);
      if (!metric) {
        throw new Error(`No version metric registered for target "${target.name}"`);
      }
      metric.reset();
      for (const version of versions) {
        metric.set(
          {
            label: target.label,
            version: version.version,
            namespace: version.namespace,
            pod: version.pod,
            container: version.container,
            image: version.image,
          },
          1,
        );
      }
    }
  }
}
