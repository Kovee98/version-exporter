export interface ImageReference {
  registry: string;
  repository: string;
  tag: string;
}

/**
 * A tag reduced to its literal "shape" plus the numbers that vary within it. Digit runs become `#`
 * and commit-hash segments become `*`, so "2024.10.22-7ca5933" has the shape "#.#.#-*".
 */
export interface VersionTag {
  shape: string;
  prefix: string;
  numbers: number[];
}

export interface ImageInstance {
  image: string;
  digest?: string;
}

export type TagLister = (
  registry: string,
  repository: string,
  timeoutMs: number,
  last?: string,
) => Promise<string[]>;
export type DigestLookup = (registry: string, repository: string, tag: string, timeoutMs: number) => Promise<string>;

const DOCKER_HUB = "docker.io";
const DOCKER_HUB_API = "registry-1.docker.io";
const MAX_TAG_PAGES = 50;
const MAX_PAGE_BYTES = 4 * 1_048_576;
const MAX_RATE_LIMIT_RETRIES = 3;
const FAILURE_RETRY_MS = 10 * 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 30_000;
const HASH_SEGMENT = /^(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,64}$/;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export function parseImageReference(image: string): ImageReference | undefined {
  const [withoutDigest] = image.split("@", 1);
  if (!withoutDigest) return undefined;

  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  if (lastColon <= lastSlash) return undefined;

  const name = withoutDigest.slice(0, lastColon);
  const tag = withoutDigest.slice(lastColon + 1);
  const [first, ...rest] = name.split("/");
  if (!first || !tag) return undefined;

  const hasRegistry = rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry ? first : DOCKER_HUB;
  let repository = hasRegistry ? rest.join("/") : name;
  if (registry === DOCKER_HUB && !repository.includes("/")) {
    repository = `library/${repository}`;
  }
  return { registry, repository, tag };
}

export function parseVersionTag(tag: string): VersionTag | undefined {
  const numbers: number[] = [];
  const shape = tag
    .split(/([._+-])/)
    .map((segment) => {
      if (HASH_SEGMENT.test(segment)) return "*";
      return segment.replace(/\d+/g, (digits) => {
        numbers.push(Number(digits));
        return "#";
      });
    })
    .join("");
  if (numbers.length === 0 || numbers.some((value) => !Number.isSafeInteger(value))) return undefined;
  return { shape, prefix: shape.slice(0, shape.search(/[#*]/)), numbers };
}

function compareNumbers(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Picks the highest tag with the same shape as the current one, so "16.4-alpine" only moves to e.g.
 * "17.0-alpine" (never "17", "17.0-bookworm" or "17.0-rc1-alpine").
 */
export function newestMatchingTag(
  currentTag: string,
  tags: string[],
  ignore: (tag: string) => boolean = () => false,
): string | undefined {
  const current = parseVersionTag(currentTag);
  if (!current) return undefined;

  let best: { tag: string; version: VersionTag } = { tag: currentTag, version: current };
  for (const tag of tags) {
    const version = parseVersionTag(tag);
    if (
      version &&
      version.shape === current.shape &&
      compareNumbers(version.numbers, best.version.numbers) > 0 &&
      !ignore(tag)
    ) {
      best = { tag, version };
    }
  }
  return best.tag;
}

export const listRegistryTags: TagLister = async (registry, repository, timeoutMs, last) => {
  let url: URL | undefined = new URL(`https://${apiHost(registry)}/v2/${repository}/tags/list?n=1000`);
  if (last) url.searchParams.set("last", last);
  const session = new RegistrySession(timeoutMs);
  const tags: string[] = [];

  for (let page = 0; url && page < MAX_TAG_PAGES; page += 1) {
    const response = await session.request(url, "GET", "application/json");
    if (!response.ok) {
      throw new Error(`Listing tags for ${registry}/${repository} failed with status ${response.status}`);
    }

    const parsed: unknown = JSON.parse(await readLimited(response));
    if (typeof parsed === "object" && parsed !== null && "tags" in parsed && Array.isArray(parsed.tags)) {
      tags.push(...parsed.tags.filter((tag): tag is string => typeof tag === "string"));
    }

    const next = /<([^>]+)>;\s*rel="?next"?/.exec(response.headers.get("link") ?? "")?.[1];
    url = next ? new URL(next, url) : undefined;
  }
  return tags;
};

export const lookupManifestDigest: DigestLookup = async (registry, repository, tag, timeoutMs) => {
  const url = new URL(`https://${apiHost(registry)}/v2/${repository}/manifests/${encodeURIComponent(tag)}`);
  // HEAD requests don't count against Docker Hub's pull rate limit.
  const response = await new RegistrySession(timeoutMs).request(url, "HEAD", MANIFEST_TYPES);
  if (!response.ok) {
    throw new Error(`Manifest lookup for ${registry}/${repository}:${tag} failed with status ${response.status}`);
  }
  const digest = response.headers.get("docker-content-digest");
  if (!digest?.startsWith("sha256:")) {
    throw new Error(`Manifest lookup for ${registry}/${repository}:${tag} returned no digest`);
  }
  return digest;
};

function apiHost(registry: string): string {
  return registry === DOCKER_HUB ? DOCKER_HUB_API : registry;
}

class RegistrySession {
  private authorization: string | undefined;

  constructor(private readonly timeoutMs: number) {}

  async request(url: URL, method: "GET" | "HEAD", accept: string): Promise<Response> {
    let response = await this.#fetchWithRetry(url, method, accept);
    if (response.status === 401 && !this.authorization) {
      this.authorization = await this.#anonymousToken(response.headers.get("www-authenticate"));
      response = await this.#fetchWithRetry(url, method, accept);
    }
    return response;
  }

  async #fetchWithRetry(url: URL, method: "GET" | "HEAD", accept: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#fetch(url, method, accept);
      if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : 2_000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, MAX_RATE_LIMIT_DELAY_MS)));
    }
  }

  #fetch(url: URL, method: "GET" | "HEAD", accept: string): Promise<Response> {
    return fetch(url, {
      method,
      headers: { accept, ...(this.authorization ? { authorization: this.authorization } : {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async #anonymousToken(challenge: string | null): Promise<string> {
    if (!challenge?.toLowerCase().startsWith("bearer ")) {
      throw new Error("Registry requires authentication that is not supported");
    }
    const parameters = Object.fromEntries(
      [...challenge.slice(7).matchAll(/(\w+)="([^"]*)"/g)].map(([, key = "", value = ""]) => [key, value]),
    );
    if (!parameters.realm) throw new Error("Registry auth challenge has no realm");

    const tokenUrl = new URL(parameters.realm);
    if (parameters.service) tokenUrl.searchParams.set("service", parameters.service);
    if (parameters.scope) tokenUrl.searchParams.set("scope", parameters.scope);
    const response = await fetch(tokenUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Registry token request failed with status ${response.status}`);

    const body: unknown = JSON.parse(await readLimited(response));
    const token =
      typeof body === "object" && body !== null
        ? ("token" in body && body.token) || ("access_token" in body && body.access_token)
        : undefined;
    if (typeof token !== "string") throw new Error("Registry token response did not contain a token");
    return `Bearer ${token}`;
  }
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_PAGE_BYTES) throw new Error(`Registry response exceeded ${MAX_PAGE_BYTES} bytes`);
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_PAGE_BYTES) throw new Error(`Registry response exceeded ${MAX_PAGE_BYTES} bytes`);
  return body;
}

/** Formats the latest-version value for a floating tag whose registry digest differs from what's running. */
export function newerBuildLabel(tag: string, digest: string): string {
  return `${tag}@${digest.slice(0, "sha256:".length + 12)}`;
}

interface CacheEntry {
  expiresAt: number;
  latest: string | undefined;
}

export interface LatestLookupResult {
  latest: Map<string, string>;
  failures: number;
  lookups: number;
}

interface TagJob {
  reference: ImageReference;
  last: string;
  images: Array<{ key: string; image: string; tag: string }>;
}

interface DigestJob {
  key: string;
  image: string;
  reference: ImageReference;
  digests: string[];
}

/**
 * Resolves the newest version for each running image, caching results for `ttlMs`.
 * Version-shaped tags are compared against the repository's tag list; other tags (e.g. `latest`) are
 * compared by digest, so a newer build pushed to the same tag is still reported.
 */
export class LatestVersionResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly registriesWithoutLast = new Set<string>();

  constructor(
    private readonly options: {
      ttlMs: number;
      timeoutMs: number;
      concurrency?: number;
      exclude?: RegExp[];
      ignoreTags?: RegExp[];
      listTags?: TagLister;
      lookupDigest?: DigestLookup;
      logger?: Pick<Console, "error">;
      now?: () => number;
    },
  ) {}

  async resolve(instances: Iterable<ImageInstance | string>): Promise<LatestLookupResult> {
    const now = (this.options.now ?? Date.now)();
    const logger = this.options.logger ?? console;

    const digestsByImage = new Map<string, Set<string>>();
    for (const instance of instances) {
      const { image, digest } = typeof instance === "string" ? { image: instance, digest: undefined } : instance;
      const digests = digestsByImage.get(image) ?? new Set<string>();
      if (digest) digests.add(digest);
      digestsByImage.set(image, digests);
    }

    const keys = new Map<string, string>();
    const tagJobs = new Map<string, TagJob>();
    const digestJobs: DigestJob[] = [];
    for (const [image, digestSet] of digestsByImage) {
      const digests = [...digestSet].sort();
      const key = `${image}|${digests.join(",")}`;
      keys.set(image, key);
      const cached = this.cache.get(key);
      if (cached && now < cached.expiresAt) continue;

      const reference = parseImageReference(image);
      const excluded = this.options.exclude?.some((pattern) => pattern.test(image)) ?? false;
      if (excluded || !reference) {
        this.cache.set(key, { expiresAt: now + this.options.ttlMs, latest: undefined });
        continue;
      }

      const version = parseVersionTag(reference.tag);
      if (version) {
        const jobKey = `${reference.registry}/${reference.repository}|${version.prefix}`;
        const job = tagJobs.get(jobKey) ?? { reference, last: version.prefix, images: [] };
        job.images.push({ key, image, tag: reference.tag });
        tagJobs.set(jobKey, job);
      } else if (digests.length > 0) {
        digestJobs.push({ key, image, reference, digests });
      } else {
        this.cache.set(key, { expiresAt: now + this.options.ttlMs, latest: undefined });
      }
    }

    // Failed lookups (usually registry rate limits) are retried sooner than successful ones are refreshed.
    const failureTtl = Math.min(this.options.ttlMs, FAILURE_RETRY_MS);
    let failures = 0;
    const fail = (subject: string, error: unknown) => {
      failures += 1;
      logger.error(`Latest-version lookup failed for ${subject}: ${errorMessage(error)}`);
    };
    const work: Array<() => Promise<void>> = [
      ...[...tagJobs.values()].map((job) => async () => {
        const repository = `${job.reference.registry}/${job.reference.repository}`;
        const ignore = (tag: string) => this.options.ignoreTags?.some((pattern) => pattern.test(`${repository}:${tag}`)) ?? false;
        let tags: string[] | undefined;
        try {
          tags = await this.#listComparableTags(job);
        } catch (error) {
          fail(repository, error);
        }
        for (const { key, tag } of job.images) {
          this.cache.set(key, {
            expiresAt: now + (tags ? this.options.ttlMs : failureTtl),
            latest: tags ? newestMatchingTag(tag, tags, ignore) : undefined,
          });
        }
      }),
      ...digestJobs.map((job) => async () => {
        const { registry, repository, tag } = job.reference;
        let latest: string | undefined;
        try {
          const remote = await (this.options.lookupDigest ?? lookupManifestDigest)(
            registry,
            repository,
            tag,
            this.options.timeoutMs,
          );
          latest = job.digests.every((digest) => digest === remote) ? tag : newerBuildLabel(tag, remote);
        } catch (error) {
          fail(`${registry}/${repository}:${tag}`, error);
        }
        this.cache.set(job.key, { expiresAt: now + (latest ? this.options.ttlMs : failureTtl), latest });
      }),
    ];
    const lookups = work.length;
    const worker = async () => {
      for (let next = work.shift(); next; next = work.shift()) await next();
    };
    await Promise.all(Array.from({ length: Math.max(1, this.options.concurrency ?? 4) }, worker));

    const latest = new Map<string, string>();
    for (const [image, key] of keys) {
      const value = this.cache.get(key)?.latest;
      if (value) latest.set(image, value);
    }
    const live = new Set(keys.values());
    for (const key of this.cache.keys()) {
      if (!live.has(key)) this.cache.delete(key);
    }
    return { latest, failures, lookups };
  }

  /**
   * Starts the listing at the tag's literal prefix (e.g. "v") so repositories with thousands of
   * hash/signature tags stay within the page limit. Registries that mishandle `last` (ghcr.io returns
   * nothing for a non-existent tag) get a full listing instead, and are remembered so later lookups
   * skip the wasted request.
   */
  async #listComparableTags(job: TagJob): Promise<string[]> {
    const listTags = this.options.listTags ?? listRegistryTags;
    const { registry, repository } = job.reference;
    const shapes = new Set(job.images.map(({ tag }) => parseVersionTag(tag)?.shape));
    if (job.last && !this.registriesWithoutLast.has(registry)) {
      const tags = await listTags(registry, repository, this.options.timeoutMs, job.last);
      if (tags.some((tag) => shapes.has(parseVersionTag(tag)?.shape))) return tags;
      this.registriesWithoutLast.add(registry);
    }
    return listTags(registry, repository, this.options.timeoutMs);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
