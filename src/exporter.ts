import { parseDuration } from "./duration.js";
import { scrapeHttpTarget } from "./http-target.js";
import { discoverKubernetesImages } from "./kubernetes-target.js";
import type { KubernetesDiscoveryOptions } from "./kubernetes-target.js";
import { ExporterMetrics } from "./metrics.js";
import { ScrapeScheduler } from "./scheduler.js";
import type { ConfiguredTarget, ExporterConfig, JsonRequester, VersionResult } from "./types.js";

interface ExporterOptions {
  requestJson?: JsonRequester;
  discoverImages?: (options: KubernetesDiscoveryOptions) => Promise<VersionResult[]>;
  logger?: Pick<Console, "error">;
}

export class VersionExporter {
  readonly metrics: ExporterMetrics;
  private readonly logger: Pick<Console, "error">;
  private readonly requestJson?: JsonRequester;
  private readonly discoverImages?: ExporterOptions["discoverImages"];
  private readonly scheduler: ScrapeScheduler;

  constructor(config: ExporterConfig, { requestJson, discoverImages, logger = console }: ExporterOptions = {}) {
    this.metrics = new ExporterMetrics(config.targets);
    this.logger = logger;
    this.requestJson = requestJson;
    this.discoverImages = discoverImages;
    this.scheduler = new ScrapeScheduler(config, (target) => this.#scrape(target));
  }

  start(): void {
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
  }

  async #scrape(target: ConfiguredTarget): Promise<void> {
    const startedAt = Date.now();
    let versions: VersionResult[];
    try {
      versions = await this.#withRetries(target, async (timeoutMs: number) => {
        if (target.type === "http") {
          return scrapeHttpTarget(target, {
            timeoutMs,
            requestJson: this.requestJson,
          });
        }
        return (this.discoverImages ?? discoverKubernetesImages)({ timeoutMs });
      });
      this.metrics.recordScrape(target, {
        success: true,
        versions,
        durationSeconds: (Date.now() - startedAt) / 1_000,
      });
    } catch (error) {
      this.metrics.recordScrape(target, {
        success: false,
        durationSeconds: (Date.now() - startedAt) / 1_000,
      });
      this.logger.error(`Scrape failed for target "${target.name}": ${errorMessage(error)}`);
    }
  }

  async #withRetries(
    target: ConfiguredTarget,
    scrape: (timeoutMs: number) => Promise<VersionResult[]>,
  ): Promise<VersionResult[]> {
    const timeoutMs = parseDuration(target.timeout, `targets.${target.name}.timeout`);
    const backoffMs = parseDuration(target.backoff, `targets.${target.name}.backoff`);
    let lastError;

    for (let attempt = 0; attempt <= target.retries; attempt += 1) {
      try {
        return await scrape(timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt < target.retries) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs * 2 ** attempt, 60_000)));
        }
      }
    }

    throw lastError ?? new Error(`Scrape failed for target "${target.name}"`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
