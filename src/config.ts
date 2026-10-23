import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { Ajv, type AnySchema } from "ajv";
import { parseDuration } from "./duration.js";
import type {
  ConfigInput,
  ConfigDefaults,
  ConfiguredTarget,
  DockerTarget,
  ExporterConfig,
  GroupConfig,
  HttpTarget,
  KubernetesTarget,
  LatestLookupConfig,
  PushConfig,
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
        system: { type: "string", minLength: 1 },
        every: { type: "string" },
        timeout: { type: "string" },
        retries: { type: "integer", minimum: 0, maximum: 10 },
        backoff: { type: "string" },
        concurrency: { type: "integer", minimum: 1, maximum: 32 },
      },
    },
    push: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1 },
        every: { type: "string" },
        timeout: { type: "string" },
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
          type: { enum: ["http", "kubernetes", "docker"] },
          system: { type: "string", minLength: 1 },
          group: { type: "string", minLength: 1 },
          url: { type: "string", minLength: 1 },
          jsonpath: { type: "string", minLength: 1 },
          endpoint: { type: "string", minLength: 1 },
          nodes: { type: "boolean" },
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
              checkDigests: { enum: ["all", "floating"] },
              upstreams: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["match", "repository"],
                  properties: {
                    match: { type: "string", minLength: 1 },
                    repository: { type: "string", minLength: 1, pattern: "^[^@\\s]+$" },
                  },
                },
              },
            },
          },
        },
        allOf: [
          {
            if: { properties: { type: { const: "http" } }, required: ["type"] },
            then: { required: ["url", "jsonpath"] },
          },
          {
            if: { properties: { type: { enum: ["kubernetes", "docker"] } }, required: ["type"] },
            then: { not: { anyOf: [{ required: ["url"] }, { required: ["jsonpath"] }] } },
          },
          {
            if: { properties: { type: { const: "http" } }, required: ["type"] },
            then: { not: { anyOf: [{ required: ["latest"] }, { required: ["endpoint"] }, { required: ["nodes"] }] } },
          },
          {
            if: { properties: { type: { const: "kubernetes" } }, required: ["type"] },
            then: { not: { required: ["endpoint"] } },
          },
          {
            if: { properties: { type: { const: "docker" } }, required: ["type"] },
            then: { not: { required: ["nodes"] } },
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
    system: hostname(),
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
      system: target.system ?? defaults.system,
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

    const { latest: latestInput, nodes, ...imageBase } = configuredBase;
    let latest: LatestLookupConfig | undefined;
    if (latestInput) {
      latest = {
        every: latestInput.every ?? "6h",
        concurrency: latestInput.concurrency ?? 4,
        exclude: latestInput.exclude ?? [],
        ignoreTags: latestInput.ignoreTags ?? [],
        upstreams: latestInput.upstreams ?? [],
        checkDigests: latestInput.checkDigests ?? "all",
      };
      parseDuration(latest.every, `targets.${target.name}.latest.every`);
      for (const { repository } of latest.upstreams) {
        if (repository.slice(repository.lastIndexOf("/") + 1).includes(":")) {
          throw new Error(`Target "${target.name}" latest.upstreams repository "${repository}" must not include a tag`);
        }
      }
      const upstreamPatterns = latest.upstreams.map(({ match }) => match);
      for (const [option, patterns] of [
        ["exclude", latest.exclude],
        ["ignoreTags", latest.ignoreTags],
        ["upstreams", upstreamPatterns],
      ] as const) {
        for (const pattern of patterns) {
          try {
            new RegExp(pattern);
          } catch {
            throw new Error(`Target "${target.name}" has an invalid latest.${option} pattern "${pattern}"`);
          }
        }
      }
    }
    if (imageBase.type === "docker") {
      const endpoint = imageBase.endpoint ?? DEFAULT_DOCKER_ENDPOINT;
      dockerEndpoint(endpoint, target.name);
      return { ...imageBase, type: "docker", endpoint, ...(latest ? { latest } : {}) } satisfies DockerTarget;
    }
    return {
      ...imageBase,
      type: "kubernetes",
      nodes: nodes ?? false,
      ...(latest ? { latest } : {}),
    } satisfies KubernetesTarget;
  });

  let push: PushConfig | undefined;
  if (value.push) {
    push = { every: "1m", timeout: "10s", ...value.push };
    parseDuration(push.every, "push.every");
    parseDuration(push.timeout, "push.timeout");
    let url;
    try {
      url = new URL(push.url);
    } catch {
      throw new Error("push.url is not a valid URL");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("push.url must use HTTP or HTTPS");
    }
    if (url.username || url.password) {
      throw new Error("push.url must not contain embedded credentials");
    }
  }

  return { defaults, groups: [...groups.values()], targets, ...(push ? { push } : {}) };
}

export const DEFAULT_DOCKER_ENDPOINT = "unix:///var/run/docker.sock";

/** Splits a Docker endpoint into the base URL to request and, for `unix://` endpoints, the socket path. */
export function dockerEndpoint(endpoint: string, targetName = "docker"): { baseUrl: string; socketPath?: string } {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Target "${targetName}" has an invalid Docker endpoint`);
  }
  if (url.protocol === "unix:") {
    if (!url.pathname || url.pathname === "/") {
      throw new Error(`Target "${targetName}" Docker endpoint must include a socket path`);
    }
    return { baseUrl: "http://localhost", socketPath: decodeURIComponent(url.pathname) };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Target "${targetName}" Docker endpoint must use unix, HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`Target "${targetName}" Docker endpoint must not contain embedded credentials`);
  }
  return { baseUrl: url.origin + url.pathname.replace(/\/$/, "") };
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
