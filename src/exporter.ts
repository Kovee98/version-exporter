import { discoverDockerContainers, type DockerDiscoveryOptions } from "./docker-target.js";
import { parseDuration } from "./duration.js";
import { postText, type TextPoster } from "./http.js";
import { scrapeHttpTarget } from "./http-target.js";
import { discoverKubernetesImages } from "./kubernetes-target.js";
import type { KubernetesDiscoveryOptions } from "./kubernetes-target.js";
import { ExporterMetrics } from "./metrics.js";
import { LatestVersionResolver, type DigestLookup, type TagLister } from "./registry.js";
import { ScrapeScheduler } from "./scheduler.js";
import type { ConfiguredTarget, ExporterConfig, JsonRequester, PushConfig, VersionResult } from "./types.js";

interface ExporterOptions {
  requestJson?: JsonRequester;
  discoverImages?: (options: KubernetesDiscoveryOptions) => Promise<VersionResult[]>;
  discoverContainers?: (options: DockerDiscoveryOptions) => Promise<VersionResult[]>;
  postText?: TextPoster;
  listTags?: TagLister;
  lookupDigest?: DigestLookup;
  logger?: Pick<Console, "error">;
}

export class VersionExporter {
  readonly metrics: ExporterMetrics;
  private readonly logger: Pick<Console, "error">;
  private readonly requestJson?: JsonRequester;
  private readonly discoverImages?: ExporterOptions["discoverImages"];
  private readonly discoverContainers?: ExporterOptions["discoverContainers"];
  private readonly postText: TextPoster;
  private readonly push?: PushConfig;
  private readonly resolvers = new Map<string, LatestVersionResolver>();
  private readonly scheduler: ScrapeScheduler;
  private pushTimer?: NodeJS.Timeout;
  private pushing?: Promise<void>;

  constructor(
    config: ExporterConfig,
    {
      requestJson,
      discoverImages,
      discoverContainers,
      postText: post = postText,
      listTags,
      lookupDigest,
      logger = console,
    }: ExporterOptions = {},
  ) {
    this.metrics = new ExporterMetrics(config.targets, config.defaults.system);
    this.logger = logger;
    this.requestJson = requestJson;
    this.discoverImages = discoverImages;
    this.discoverContainers = discoverContainers;
    this.postText = post;
    this.push = config.push;
    for (const target of config.targets) {
      if (target.type !== "http" && target.latest) {
        this.resolvers.set(
          target.name,
          new LatestVersionResolver({
            ttlMs: parseDuration(target.latest.every, `targets.${target.name}.latest.every`),
            timeoutMs: parseDuration(target.timeout, `targets.${target.name}.timeout`),
            concurrency: target.latest.concurrency,
            exclude: target.latest.exclude.map((pattern) => new RegExp(pattern)),
            ignoreTags: target.latest.ignoreTags.map((pattern) => new RegExp(pattern)),
            upstreams: target.latest.upstreams.map(({ match, repository }) => ({ match: new RegExp(match), repository })),
            checkDigests: target.latest.checkDigests,
            ...(listTags ? { listTags } : {}),
            ...(lookupDigest ? { lookupDigest } : {}),
            logger,
          }),
        );
      }
    }
    this.scheduler = new ScrapeScheduler(config, (target) => this.#scrape(target));
  }

  start(): void {
    this.scheduler.start();
    if (this.push) {
      const everyMs = parseDuration(this.push.every, "push.every");
      this.pushTimer = setInterval(() => void this.pushMetrics(), everyMs);
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.pushTimer);
    this.pushTimer = undefined;
    await this.scheduler.stop();
    await this.pushing;
  }

  /** Sends the current metrics to `push.url` in the Prometheus text format; skips if a push is still running. */
  async pushMetrics(): Promise<void> {
    if (!this.push || this.pushing) return;
    const push = this.push;
    this.pushing = (async () => {
      try {
        await this.postText(push.url, await this.metrics.registry.metrics(), {
          timeoutMs: parseDuration(push.timeout, "push.timeout"),
        });
        this.metrics.recordPush(true);
      } catch (error) {
        this.metrics.recordPush(false);
        this.logger.error(`Pushing metrics to ${push.url} failed: ${errorMessage(error)}`);
      } finally {
        this.pushing = undefined;
      }
    })();
    await this.pushing;
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
        if (target.type === "docker") {
          return (this.discoverContainers ?? discoverDockerContainers)({
            endpoint: target.endpoint,
            timeoutMs,
            ...(this.requestJson ? { requestJson: this.requestJson } : {}),
          });
        }
        return (this.discoverImages ?? discoverKubernetesImages)({ timeoutMs, nodes: target.nodes });
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
      return;
    }

    const resolver = this.resolvers.get(target.name);
    if (resolver) {
      try {
        this.metrics.recordLatest(target, await resolver.resolve(versions));
      } catch (error) {
        this.logger.error(`Latest-version lookup failed for target "${target.name}": ${errorMessage(error)}`);
      }
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
