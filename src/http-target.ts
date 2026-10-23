import { JSONPath } from "jsonpath-plus";
import { requestJson } from "./http.js";
import type { HttpTarget, JsonRequester, VersionResult } from "./types.js";
import type { JSONPathOptions } from "jsonpath-plus";

interface HttpTargetScrapeOptions {
  timeoutMs: number;
  requestJson?: JsonRequester;
}

export async function scrapeHttpTarget(
  target: HttpTarget,
  options: HttpTargetScrapeOptions,
): Promise<VersionResult[]> {
  const json = await (options.requestJson ?? requestJson)(target.url, {
    timeoutMs: options.timeoutMs,
  });
  if (!isJsonValue(json)) {
    throw new Error("HTTP response was not a valid JSON value");
  }
  const values = JSONPath<unknown[]>({
    path: target.jsonpath,
    json,
    wrap: true,
    eval: "safe",
  });

  if (values.length !== 1) {
    throw new Error(`JSONPath "${target.jsonpath}" returned ${values.length} values; expected one`);
  }

  function isJsonValue(value: unknown): value is JSONPathOptions["json"] {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (typeof value === "object") return Object.values(value).every(isJsonValue);
    return false;
  }

  const version: unknown = values[0];
  if ((typeof version !== "string" && typeof version !== "number") || String(version).trim() === "") {
    throw new Error(`JSONPath "${target.jsonpath}" did not resolve to a non-empty string or number`);
  }

  return [
    {
      version: String(version),
      namespace: "",
      pod: "",
      container: "",
      image: "",
    },
  ];
}
