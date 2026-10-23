const UNITS = new Map([
  ["ms", 1],
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["hr", 3_600_000],
  ["d", 86_400_000],
]);

const MAX_TIMEOUT_MS = 2_147_483_647;

export function parseDuration(value: string, fieldName = "duration"): number {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a duration such as "10s" or "1h"`);
  }

  const match = /^([1-9]\d*)(ms|hr|s|m|h|d)$/.exec(value);
  if (!match) {
    throw new Error(`${fieldName} must be a positive duration such as "10s" or "1h"`);
  }

  const unit = UNITS.get(match[2]);
  if (unit === undefined) {
    throw new Error(`${fieldName} uses an unsupported duration unit`);
  }
  const milliseconds = Number(match[1]) * unit;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_TIMEOUT_MS) {
    throw new Error(`${fieldName} must not exceed ${MAX_TIMEOUT_MS}ms`);
  }

  return milliseconds;
}
