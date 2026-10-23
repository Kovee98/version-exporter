import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { ConfiguredTarget, VersionResult } from "./types.js";

const VERSION_LABELS = ["system", "label", "version", "namespace", "pod", "container", "image"];

export class ExporterMetrics {
  readonly registry: Registry;
  private readonly targetMetrics: Map<string, Gauge<string>>;
  private readonly targetUp: Gauge<string>;
  private readonly lastScrape: Gauge<string>;
  private readonly scrapeDuration: Gauge<string>;
  private readonly scrapes: Counter<string>;
  private readonly imageLatest: Gauge<string>;
  private readonly latestLookups: Counter<string>;
  private readonly latestImages = new Map<string, Map<string, string>>();
  private readonly pushes: Counter<string>;

  constructor(
    targets: ConfiguredTarget[],
    private readonly system = "",
  ) {
    this.registry = new Registry();
    this.targetMetrics = new Map();
    this.targetUp = new Gauge({
      name: "version_exporter_target_up",
      help: "Whether the most recent target scrape succeeded.",
      labelNames: ["target", "system"],
      registers: [this.registry],
    });
    this.lastScrape = new Gauge({
      name: "version_exporter_target_last_scrape_timestamp_seconds",
      help: "Unix timestamp of the most recent target scrape.",
      labelNames: ["target", "system"],
      registers: [this.registry],
    });
    this.scrapeDuration = new Gauge({
      name: "version_exporter_target_scrape_duration_seconds",
      help: "Duration of the most recent target scrape in seconds.",
      labelNames: ["target", "system"],
      registers: [this.registry],
    });
    this.scrapes = new Counter({
      name: "version_exporter_target_scrapes_total",
      help: "Number of target scrapes by outcome.",
      labelNames: ["target", "system", "result"],
      registers: [this.registry],
    });
    this.imageLatest = new Gauge({
      name: "version_exporter_image_latest",
      help: "Newest registry tag with the same shape as a running image's tag.",
      labelNames: ["target", "system", "image", "latest_version"],
      registers: [this.registry],
    });
    this.latestLookups = new Counter({
      name: "version_exporter_latest_lookups_total",
      help: "Number of registry repository tag lookups by outcome.",
      labelNames: ["target", "system", "result"],
      registers: [this.registry],
    });

    this.pushes = new Counter({
      name: "version_exporter_pushes_total",
      help: "Number of metric pushes to push.url by outcome.",
      labelNames: ["system", "result"],
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
    const labels = { target: target.name, system: target.system };
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
            system: target.system,
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

  recordLatest(
    target: ConfiguredTarget,
    { latest, failures, lookups }: { latest: Map<string, string>; failures: number; lookups: number },
  ): void {
    const labels = { target: target.name, system: target.system };
    const previous = this.latestImages.get(target.name) ?? new Map<string, string>();
    for (const [image, version] of previous) {
      this.imageLatest.remove({ ...labels, image, latest_version: version });
    }
    for (const [image, version] of latest) {
      this.imageLatest.set({ ...labels, image, latest_version: version }, 1);
    }
    this.latestImages.set(target.name, new Map(latest));
    if (lookups - failures > 0) this.latestLookups.inc({ ...labels, result: "success" }, lookups - failures);
    if (failures > 0) this.latestLookups.inc({ ...labels, result: "error" }, failures);
  }

  recordPush(success: boolean): void {
    this.pushes.inc({ system: this.system, result: success ? "success" : "error" });
  }
}
