import { readFile } from "node:fs/promises";
import { Ajv, type AnySchema } from "ajv";
import { parseDuration } from "./duration.js";
import type {
  ConfigInput,
  ConfigDefaults,
  ConfiguredTarget,
  ExporterConfig,
  GroupConfig,
  HttpTarget,
  KubernetesTarget,
  LatestLookupConfig,
  TargetInput,
} from "./types.js";

const schema: AnySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    defaults: {
      type: "object",
      additionalProperties: false,
      properties: {
        every: { type: "string" },
        timeout: { type: "string" },
        retries: { type: "integer", minimum: 0, maximum: 10 },
        backoff: { type: "string" },
        concurrency: { type: "integer", minimum: 1, maximum: 32 },
      },
    },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mode"],
        properties: {
          name: { type: "string", minLength: 1 },
          mode: { enum: ["serial", "parallel"] },
          concurrency: { type: "integer", minimum: 1, maximum: 32 },
        },
      },
    },
    targets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "label", "type"],
        properties: {
          name: { type: "string", minLength: 1, pattern: "^[a-zA-Z0-9_-]+$" },
          label: { type: "string", minLength: 1 },
          type: { enum: ["http", "kubernetes"] },
          group: { type: "string", minLength: 1 },
          url: { type: "string", minLength: 1 },
          jsonpath: { type: "string", minLength: 1 },
          every: { type: "string" },
          timeout: { type: "string" },
          retries: { type: "integer", minimum: 0, maximum: 10 },
          backoff: { type: "string" },
          latest: {
            type: "object",
            additionalProperties: false,
            properties: {
              every: { type: "string" },
              concurrency: { type: "integer", minimum: 1, maximum: 16 },
              exclude: { type: "array", items: { type: "string", minLength: 1 } },
              ignoreTags: { type: "array", items: { type: "string", minLength: 1 } },
            },
          },
        },
        allOf: [
          {
            if: { properties: { type: { const: "http" } }, required: ["type"] },
            then: { required: ["url", "jsonpath"] },
          },
          {
            if: { properties: { type: { const: "kubernetes" } }, required: ["type"] },
            then: { not: { anyOf: [{ required: ["url"] }, { required: ["jsonpath"] }] } },
          },
          {
            if: { properties: { type: { const: "http" } }, required: ["type"] },
            then: { not: { required: ["latest"] } },
          },
        ],
      },
    },
  },
  required: ["targets"],
};

const validateSchema = new Ajv({
  allErrors: true,
  strict: true,
  strictRequired: false,
}).compile<ConfigInput>(schema);

export function validateConfig(value: unknown): ExporterConfig {
  if (!validateSchema(value)) {
    const details = (validateSchema.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const defaults: ConfigDefaults = {
    every: "1m",
    timeout: "10s",
    retries: 2,
    backoff: "1s",
    concurrency: 4,
    ...value.defaults,
  };

  parseDuration(defaults.every, "defaults.every");
  parseDuration(defaults.timeout, "defaults.timeout");
  parseDuration(defaults.backoff, "defaults.backoff");

  const groups = new Map<string, GroupConfig>([
    ["default", { name: "default", mode: "parallel", concurrency: defaults.concurrency }],
  ]);

  for (const group of value.groups ?? []) {
    if (groups.has(group.name)) {
      throw new Error(`Duplicate group name "${group.name}"`);
    }
    groups.set(group.name, {
      ...group,
      concurrency: group.mode === "serial" ? 1 : group.concurrency ?? defaults.concurrency,
    });
  }

  const metricNames = new Set();
  const targets: ConfiguredTarget[] = value.targets.map((target: TargetInput) => {
    const normalizedName = target.name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    if (!normalizedName) {
      throw new Error(`Target name "${target.name}" does not produce a valid metric name`);
    }

    const metricName = `version_exporter_${normalizedName}_version`;
    if (metricNames.has(metricName)) {
      throw new Error(`Target name "${target.name}" collides with another target metric`);
    }
    metricNames.add(metricName);

    const groupName = target.group ?? "default";
    if (!groups.has(groupName)) {
      throw new Error(`Target "${target.name}" references unknown group "${groupName}"`);
    }

    const configuredBase = {
      ...target,
      metricName,
      group: groupName,
      every: target.every ?? defaults.every,
      timeout: target.timeout ?? defaults.timeout,
      retries: target.retries ?? defaults.retries,
      backoff: target.backoff ?? defaults.backoff,
    };

    parseDuration(configuredBase.every, `targets.${target.name}.every`);
    parseDuration(configuredBase.timeout, `targets.${target.name}.timeout`);
    parseDuration(configuredBase.backoff, `targets.${target.name}.backoff`);

    if (configuredBase.type === "http") {
      let url;
      try {
        url = new URL(configuredBase.url);
      } catch {
        throw new Error(`Target "${target.name}" has an invalid URL`);
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Target "${target.name}" URL must use HTTP or HTTPS`);
      }
      if (url.username || url.password) {
        throw new Error(`Target "${target.name}" URL must not contain embedded credentials`);
      }
      return {
        ...configuredBase,
        type: "http",
        url: configuredBase.url,
        jsonpath: configuredBase.jsonpath,
      } satisfies HttpTarget;
    }

    const { latest: latestInput, ...kubernetesBase } = configuredBase;
    let latest: LatestLookupConfig | undefined;
    if (latestInput) {
      latest = {
        every: latestInput.every ?? "6h",
        concurrency: latestInput.concurrency ?? 4,
        exclude: latestInput.exclude ?? [],
        ignoreTags: latestInput.ignoreTags ?? [],
      };
      parseDuration(latest.every, `targets.${target.name}.latest.every`);
      for (const [option, patterns] of [["exclude", latest.exclude], ["ignoreTags", latest.ignoreTags]] as const) {
        for (const pattern of patterns) {
          try {
            new RegExp(pattern);
          } catch {
            throw new Error(`Target "${target.name}" has an invalid latest.${option} pattern "${pattern}"`);
          }
        }
      }
    }
    return { ...kubernetesBase, type: "kubernetes", ...(latest ? { latest } : {}) } satisfies KubernetesTarget;
  });

  return { defaults, groups: [...groups.values()], targets };
}

export async function loadConfig(filePath: string): Promise<ExporterConfig> {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read configuration file "${filePath}": ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Configuration file "${filePath}" is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  return validateConfig(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
