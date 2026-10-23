import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";
import { ScrapeScheduler } from "../src/scheduler.js";

const target = (name: string, group: string) => ({
  name,
  label: name,
  type: "kubernetes",
  group,
  every: "1h",
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for scheduler");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("serial groups run only one target at a time", async () => {
  const config = validateConfig({
    groups: [{ name: "serial", mode: "serial" }],
    targets: [target("one", "serial"), target("two", "serial"), target("three", "serial")],
  });
  let running = 0;
  let maxRunning = 0;
  let completed = 0;
  const scheduler = new ScrapeScheduler(config, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 15));
    running -= 1;
    completed += 1;
  });

  scheduler.start();
  await waitFor(() => completed === 3);
  await scheduler.stop();

  assert.equal(maxRunning, 1);
});

test("parallel groups respect their concurrency limit", async () => {
  const config = validateConfig({
    groups: [{ name: "parallel", mode: "parallel", concurrency: 2 }],
    targets: [
      target("one", "parallel"),
      target("two", "parallel"),
      target("three", "parallel"),
      target("four", "parallel"),
    ],
  });
  let running = 0;
  let maxRunning = 0;
  let completed = 0;
  const scheduler = new ScrapeScheduler(config, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 15));
    running -= 1;
    completed += 1;
  });

  scheduler.start();
  await waitFor(() => completed === 4);
  await scheduler.stop();

  assert.equal(maxRunning, 2);
});
