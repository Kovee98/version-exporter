import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.js";

test("parses supported duration units", () => {
  assert.equal(parseDuration("10ms"), 10);
  assert.equal(parseDuration("10s"), 10_000);
  assert.equal(parseDuration("1m"), 60_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("1hr"), 3_600_000);
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("rejects malformed and excessive durations", () => {
  for (const value of ["0s", "-1m", "1.5h", "10", "1w", "999999999999d"]) {
    assert.throws(() => parseDuration(value), /duration/);
  }
});
