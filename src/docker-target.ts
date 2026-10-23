import { dockerEndpoint } from "./config.js";
import { requestJson } from "./http.js";
import { imageVersion } from "./kubernetes-target.js";
import type { JsonRequester, VersionResult } from "./types.js";

// Large hosts (TrueNAS with many apps) can return a few hundred KB of container JSON.
const DOCKER_MAX_RESPONSE_BYTES = 16 * 1_048_576;
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

export interface DockerDiscoveryOptions {
  endpoint: string;
  timeoutMs: number;
  requestJson?: JsonRequester;
}

interface DockerContainer {
  Id?: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  Labels?: Record<string, string> | null;
}

interface DockerImage {
  RepoDigests?: string[] | null;
}

interface DockerContainerInspect {
  Config?: { Image?: string };
}

/**
 * Lists running containers through the Docker Engine API. Compose projects map to `namespace`, container
 * names to `pod` and compose services to `container`, so the results line up with Kubernetes ones.
 */
export async function discoverDockerContainers({
  endpoint,
  timeoutMs,
  requestJson: request = requestJson,
}: DockerDiscoveryOptions): Promise<VersionResult[]> {
  const { baseUrl, socketPath } = dockerEndpoint(endpoint);
  const get = (path: string) =>
    request(`${baseUrl}${path}`, {
      timeoutMs,
      maxResponseBytes: DOCKER_MAX_RESPONSE_BYTES,
      ...(socketPath ? { socketPath } : {}),
    });

  const containers = await get("/containers/json");
  if (!Array.isArray(containers) || !containers.every(isObject)) {
    throw new Error("Docker API response did not contain a container list");
  }

  const repoDigests = new Map<string, Promise<string[]>>();
  const imageDigests = (imageId: string) => {
    let digests = repoDigests.get(imageId);
    if (!digests) {
      digests = get(`/images/${encodeURIComponent(imageId)}/json`).then(
        (image) => {
          const list = isObject(image) ? (image as DockerImage).RepoDigests : undefined;
          return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
        },
        // Digest comparison is best effort; a vanished image shouldn't fail the whole scrape.
        () => [],
      );
      repoDigests.set(imageId, digests);
    }
    return digests;
  };

  const results = await Promise.all(
    (containers as DockerContainer[]).map(async (container): Promise<VersionResult | undefined> => {
      let image = typeof container.Image === "string" ? container.Image : "";
      // Docker reports the image ID instead of the reference once the tag has moved to a newer image.
      if ((!image || image.startsWith("sha256:")) && typeof container.Id === "string") {
        try {
          const inspect = await get(`/containers/${encodeURIComponent(container.Id)}/json`);
          image = (isObject(inspect) && (inspect as DockerContainerInspect).Config?.Image) || image;
        } catch {
          // Keep whatever /containers/json reported.
        }
      }
      if (!image || image.startsWith("sha256:")) return undefined;

      const labels = isObject(container.Labels) ? container.Labels : {};
      const name = (Array.isArray(container.Names) ? container.Names[0] ?? "" : "").replace(/^\//, "");
      const digest =
        typeof container.ImageID === "string"
          ? matchingRepoDigest(image, await imageDigests(container.ImageID))
          : undefined;
      return {
        version: imageVersion(image),
        namespace: labels["com.docker.compose.project"] ?? "",
        pod: name,
        container: labels["com.docker.compose.service"] ?? name,
        image,
        ...(digest ? { digest } : {}),
      };
    }),
  );
  return results.filter((result): result is VersionResult => result !== undefined);
}

/** Picks the digest from an image's RepoDigests (`repo@sha256:...`) that belongs to the image's own repository. */
export function matchingRepoDigest(image: string, repoDigests: string[]): string | undefined {
  const wanted = repositoryKey(image);
  for (const repoDigest of repoDigests) {
    const at = repoDigest.lastIndexOf("@");
    if (at < 0) continue;
    const digest = repoDigest.slice(at + 1);
    if (/^sha256:[0-9a-f]{64}$/.test(digest) && repositoryKey(repoDigest.slice(0, at)) === wanted) {
      return digest;
    }
  }
  return undefined;
}

/** Normalizes an image reference to `registry/repository`, treating Docker Hub's short forms as equal. */
export function repositoryKey(reference: string): string {
  let name = reference.split("@", 1)[0] ?? "";
  const lastSlash = name.lastIndexOf("/");
  const lastColon = name.lastIndexOf(":");
  if (lastColon > lastSlash) name = name.slice(0, lastColon);

  const [first = "", ...rest] = name.split("/");
  const hasRegistry = rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  let registry = hasRegistry ? first : "docker.io";
  let repository = hasRegistry ? rest.join("/") : name;
  if (DOCKER_HUB_ALIASES.has(registry)) {
    registry = "docker.io";
    if (!repository.includes("/")) repository = `library/${repository}`;
  }
  return `${registry}/${repository}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
