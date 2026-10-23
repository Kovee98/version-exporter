import { readFile } from "node:fs/promises";
import { requestJson } from "./http.js";
import type { JsonRequester, KubernetesPod, KubernetesPodList, VersionResult } from "./types.js";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const POD_PAGE_SIZE = 50;
// Full pod objects (managedFields, env, volumes) can be tens of KB each.
const POD_PAGE_MAX_BYTES = 16 * 1_048_576;

export interface KubernetesDiscoveryOptions {
  timeoutMs: number;
  requestJson?: JsonRequester;
  environment?: NodeJS.ProcessEnv;
  read?: (path: string, encoding?: BufferEncoding) => Promise<string | Buffer>;
}

export function imageVersion(image: string): string {
  const reference = image.split("@", 1)[0];
  const lastSlash = reference.lastIndexOf("/");
  const lastColon = reference.lastIndexOf(":");
  return lastColon > lastSlash ? reference.slice(lastColon + 1) : "latest";
}

function podImages(pod: KubernetesPod): VersionResult[] {
  const spec = pod.spec ?? {};
  const namespace = pod.metadata?.namespace ?? "";
  const podName = pod.metadata?.name ?? "";
  const containers = [
    ...(spec.initContainers ?? []),
    ...(spec.containers ?? []),
    ...(spec.ephemeralContainers ?? []),
  ];

  return containers.flatMap((container) => {
    if (typeof container.image !== "string" || container.image.length === 0) {
      return [];
    }
    return [{
      version: imageVersion(container.image),
      namespace,
      pod: podName,
      container: container.name ?? "",
      image: container.image,
    }];
  });
}

export async function discoverKubernetesImages({
  timeoutMs,
  requestJson: request = requestJson,
  environment = process.env,
  read = async (path, encoding) => readFile(path, encoding),
}: KubernetesDiscoveryOptions): Promise<VersionResult[]> {
  const host = environment.KUBERNETES_SERVICE_HOST;
  const port = environment.KUBERNETES_SERVICE_PORT_HTTPS ?? environment.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) {
    throw new Error("KUBERNETES_SERVICE_HOST is not set; run this target inside a Kubernetes cluster");
  }

  const serviceAccountDir = environment.KUBERNETES_SERVICE_ACCOUNT_DIR ?? SERVICE_ACCOUNT_DIR;
  let token: string;
  let ca: Buffer | string;
  try {
    const [tokenContents, caContents] = await Promise.all([
      read(`${serviceAccountDir}/token`, "utf8"),
      read(`${serviceAccountDir}/ca.crt`),
    ]);
    if (typeof tokenContents !== "string") {
      throw new Error("Kubernetes service-account token was not read as text");
    }
    token = tokenContents;
    ca = caContents;
  } catch (error) {
    throw new Error(`Unable to read Kubernetes service-account credentials: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const apiUrl = new URL(`https://${host}:${port}/api/v1/pods`);
  apiUrl.searchParams.set("limit", String(POD_PAGE_SIZE));
  const images = [];
  let continueToken;

  do {
    if (continueToken) {
      apiUrl.searchParams.set("continue", continueToken);
    }

    const page = await request(apiUrl, {
      timeoutMs,
      headers: { authorization: `Bearer ${token.trim()}` },
      ca,
      maxResponseBytes: POD_PAGE_MAX_BYTES,
    });
    if (!isKubernetesPodList(page)) {
      throw new Error("Kubernetes API response did not contain a pod list");
    }
    for (const pod of page.items) {
      images.push(...podImages(pod));
    }
    continueToken = page.metadata?.continue || undefined;
  } while (continueToken);

  return images;
}

function isKubernetesPodList(value: unknown): value is KubernetesPodList {
  if (
    typeof value !== "object" ||
    value === null ||
    !("items" in value) ||
    !Array.isArray(value.items)
  ) {
    return false;
  }
  return value.items.every(isKubernetesPod);
}

function isKubernetesPod(value: unknown): value is KubernetesPod {
  if (typeof value !== "object" || value === null) return false;
  const pod = value as Record<string, unknown>;
  if ("metadata" in pod && !isStringProperties(pod.metadata, ["namespace", "name"])) return false;
  if (pod.spec === undefined) return true;
  if (typeof pod.spec !== "object" || pod.spec === null) return false;
  const spec = pod.spec as Record<string, unknown>;
  return ["initContainers", "containers", "ephemeralContainers"].every((key) => {
    const containers = spec[key];
    return containers === undefined || (Array.isArray(containers) && containers.every(isPodContainer));
  });
}

function isPodContainer(value: unknown): boolean {
  return isStringProperties(value, ["name", "image"]);
}

function isStringProperties(value: unknown, properties: string[]): boolean {
  if (value === undefined || value === null || typeof value !== "object") return false;
  return properties.every((property) => {
    const item = (value as Record<string, unknown>)[property];
    return item === undefined || typeof item === "string";
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
