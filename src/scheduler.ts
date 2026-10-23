import { parseDuration } from "./duration.js";
import type { ExporterConfig, ConfiguredTarget } from "./types.js";

class GroupQueue {
  private readonly name: string;
  private readonly concurrency: number;
  private queue: Array<{ targetName: string; run: () => Promise<void> | void }>;
  private queuedTargets: Set<string>;
  private activeTargets: Set<string>;
  private running: number;
  private stopped: boolean;
  private inFlight: Set<Promise<void>>;

  constructor({ name, concurrency }: { name: string; concurrency: number }) {
    this.name = name;
    this.concurrency = concurrency;
    this.queue = [];
    this.queuedTargets = new Set();
    this.activeTargets = new Set();
    this.running = 0;
    this.stopped = false;
    this.inFlight = new Set();
  }

  enqueue(targetName: string, run: () => Promise<void> | void): void {
    if (this.stopped || this.queuedTargets.has(targetName) || this.activeTargets.has(targetName)) {
      return;
    }
    this.queuedTargets.add(targetName);
    this.queue.push({ targetName, run });
    this.#drain();
  }

  async stop() {
    this.stopped = true;
    this.queue = [];
    this.queuedTargets.clear();
    await Promise.all(this.inFlight);
  }

  #drain() {
    while (!this.stopped && this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) return;
      this.queuedTargets.delete(job.targetName);
      this.activeTargets.add(job.targetName);
      this.running += 1;

      const task = Promise.resolve()
        .then(job.run)
        .catch((error) => {
          console.error(`Unexpected scrape error for "${job.targetName}" in group "${this.name}":`, error);
        })
        .finally(() => {
          this.activeTargets.delete(job.targetName);
          this.running -= 1;
          this.inFlight.delete(task);
          this.#drain();
        });
      this.inFlight.add(task);
    }
  }
}

export class ScrapeScheduler {
  private readonly scrapeTarget: (target: ConfiguredTarget) => Promise<void>;
  private readonly targets: ConfiguredTarget[];
  private readonly groups: Map<string, GroupQueue>;
  private readonly timers: NodeJS.Timeout[];

  constructor(config: ExporterConfig, scrapeTarget: (target: ConfiguredTarget) => Promise<void>) {
    this.scrapeTarget = scrapeTarget;
    this.targets = config.targets;
    this.groups = new Map(
      config.groups.map((group) => [
        group.name,
        new GroupQueue({ name: group.name, concurrency: group.concurrency }),
      ]),
    );
    this.timers = [];
  }

  start(): void {
    for (const target of this.targets) {
      this.#schedule(target);
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    await Promise.all([...this.groups.values()].map((group) => group.stop()));
  }

  #schedule(target: ConfiguredTarget): void {
    const group = this.groups.get(target.group);
    const run = () => {
      if (!group) {
        throw new Error(`No scheduler group configured for "${target.group}"`);
      }
      group.enqueue(target.name, () => this.scrapeTarget(target));
    };
    run();
    const timer = setInterval(run, parseDuration(target.every, `targets.${target.name}.every`));
    timer.unref();
    this.timers.push(timer);
  }
}
