import { readFile } from "node:fs/promises";
import { requestJson } from "./http.js";
import type {
  JsonRequester,
  KubernetesNode,
  KubernetesNodeList,
  KubernetesPod,
  KubernetesPodList,
  VersionResult,
} from "./types.js";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const POD_PAGE_SIZE = 50;
// Full pod objects (managedFields, env, volumes) can be tens of KB each.
const POD_PAGE_MAX_BYTES = 16 * 1_048_576;

export interface KubernetesDiscoveryOptions {
  timeoutMs: number;
  /** Also report each node's Talos and kubelet versions. */
  nodes?: boolean;
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
  const status = pod.status ?? {};
  const namespace = pod.metadata?.namespace ?? "";
  const podName = pod.metadata?.name ?? "";
  const containers = [
    ...(spec.initContainers ?? []),
    ...(spec.containers ?? []),
    ...(spec.ephemeralContainers ?? []),
  ];
  const digests = new Map<string, string>();
  for (const containerStatus of [
    ...(Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : []),
    ...(Array.isArray(status.containerStatuses) ? status.containerStatuses : []),
    ...(Array.isArray(status.ephemeralContainerStatuses) ? status.ephemeralContainerStatuses : []),
  ]) {
    const digest = imageIdDigest(containerStatus?.imageID);
    if (typeof containerStatus?.name === "string" && digest) digests.set(containerStatus.name, digest);
  }

  return containers.flatMap((container) => {
    if (typeof container.image !== "string" || container.image.length === 0) {
      return [];
    }
    const digest = digests.get(container.name ?? "");
    return [{
      version: imageVersion(container.image),
      namespace,
      pod: podName,
      container: container.name ?? "",
      image: container.image,
      ...(digest ? { digest } : {}),
    }];
  });
}

const TALOS_OS_IMAGE = /^Talos \((v\d[^)\s]*)\)$/;

/**
 * Reports a node's OS and kubelet as image references so the registry lookup finds their newest
 * versions: Talos nodes map to `ghcr.io/siderolabs/installer` and `ghcr.io/siderolabs/kubelet`, other
 * distributions report only the Kubernetes version (as `registry.k8s.io/kube-apiserver`).
 */
export function nodeVersions(node: KubernetesNode): VersionResult[] {
  const name = node.metadata?.name ?? "";
  const info = node.status?.nodeInfo ?? {};
  const results: VersionResult[] = [];
  const talos = TALOS_OS_IMAGE.exec(info.osImage ?? "")?.[1];
  if (talos) {
    results.push({ version: talos, namespace: "", pod: name, container: "talos", image: `ghcr.io/siderolabs/installer:${talos}` });
  }
  const kubelet = info.kubeletVersion;
  if (kubelet && /^v\d/.test(kubelet)) {
    const repository = talos ? "ghcr.io/siderolabs/kubelet" : "registry.k8s.io/kube-apiserver";
    results.push({ version: kubelet, namespace: "", pod: name, container: "kubelet", image: `${repository}:${kubelet}` });
  }
  return results;
}

/** Extracts the repo digest from a container status imageID like "docker.io/library/nginx@sha256:...". */
export function imageIdDigest(imageID: unknown): string | undefined {
  if (typeof imageID !== "string") return undefined;
  const match = /@(sha256:[0-9a-f]{64})$/.exec(imageID);
  return match?.[1];
}

export async function discoverKubernetesImages({
  timeoutMs,
  nodes = false,
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

  const list = async <T extends { items: unknown[]; metadata?: { continue?: string } }>(
    resource: string,
    isList: (value: unknown) => value is T,
  ): Promise<T["items"]> => {
    const apiUrl = new URL(`https://${host}:${port}/api/v1/${resource}`);
    apiUrl.searchParams.set("limit", String(POD_PAGE_SIZE));
    const items: T["items"] = [];
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
      if (!isList(page)) {
        throw new Error(`Kubernetes API response did not contain a ${resource} list`);
      }
      items.push(...page.items);
      continueToken = page.metadata?.continue || undefined;
    } while (continueToken);
    return items;
  };

  const images = (await list("pods", isKubernetesPodList)).flatMap(podImages);
  if (nodes) {
    images.push(...(await list("nodes", isKubernetesNodeList)).flatMap(nodeVersions));
  }
  return images;
}

function isKubernetesNodeList(value: unknown): value is KubernetesNodeList {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray(value.items) &&
    value.items.every((node) => typeof node === "object" && node !== null)
  );
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
