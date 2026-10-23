export interface ImageReference {
  registry: string;
  repository: string;
  tag: string;
}

export interface VersionTag {
  prefix: string;
  numbers: number[];
  suffix: string;
}

export type TagLister = (registry: string, repository: string, timeoutMs: number) => Promise<string[]>;

const DOCKER_HUB = "docker.io";
const DOCKER_HUB_API = "registry-1.docker.io";
const MAX_TAG_PAGES = 50;
const MAX_PAGE_BYTES = 4 * 1_048_576;
const VERSION_TAG = /^(v?)(\d+(?:\.\d+){0,3})((?:[-_+][0-9A-Za-z._-]*)?)$/;

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
  const match = VERSION_TAG.exec(tag);
  if (!match) return undefined;
  const [, prefix = "", numbers = "", suffix = ""] = match;
  // A suffix carrying its own version (e.g. "-rc1", "-ls270") can't be matched against other tags.
  if (/\d/.test(suffix)) return undefined;
  return { prefix, numbers: numbers.split(".").map(Number), suffix };
}

function compareNumbers(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Picks the highest tag with the same shape (prefix, component count, suffix) as the current one,
 * so "16.4-alpine" only moves to e.g. "17.0-alpine", never "17" or "17.0-bookworm".
 */
export function newestMatchingTag(currentTag: string, tags: string[]): string | undefined {
  const current = parseVersionTag(currentTag);
  if (!current) return undefined;

  let best: { tag: string; version: VersionTag } = { tag: currentTag, version: current };
  for (const tag of tags) {
    const version = parseVersionTag(tag);
    if (
      version &&
      version.prefix === current.prefix &&
      version.suffix === current.suffix &&
      version.numbers.length === current.numbers.length &&
      compareNumbers(version.numbers, best.version.numbers) > 0
    ) {
      best = { tag, version };
    }
  }
  return best.tag;
}

export const listRegistryTags: TagLister = async (registry, repository, timeoutMs) => {
  const host = registry === DOCKER_HUB ? DOCKER_HUB_API : registry;
  let url: URL | undefined = new URL(`https://${host}/v2/${repository}/tags/list?n=1000`);
  let authorization: string | undefined;
  const tags: string[] = [];

  for (let page = 0; url && page < MAX_TAG_PAGES; page += 1) {
    let response = await fetchWithTimeout(url, authorization, timeoutMs);
    if (response.status === 401 && !authorization) {
      authorization = await anonymousToken(response.headers.get("www-authenticate"), timeoutMs);
      response = await fetchWithTimeout(url, authorization, timeoutMs);
    }
    if (!response.ok) {
      throw new Error(`Listing tags for ${registry}/${repository} failed with status ${response.status}`);
    }

    const body = await readLimited(response);
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "tags" in parsed && Array.isArray(parsed.tags)) {
      tags.push(...parsed.tags.filter((tag): tag is string => typeof tag === "string"));
    }

    const next = /<([^>]+)>;\s*rel="?next"?/.exec(response.headers.get("link") ?? "")?.[1];
    url = next ? new URL(next, url) : undefined;
  }
  return tags;
};

async function anonymousToken(challenge: string | null, timeoutMs: number): Promise<string> {
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
  const response = await fetchWithTimeout(tokenUrl, undefined, timeoutMs);
  if (!response.ok) throw new Error(`Registry token request failed with status ${response.status}`);

  const body: unknown = JSON.parse(await readLimited(response));
  const token =
    typeof body === "object" && body !== null
      ? ("token" in body && body.token) || ("access_token" in body && body.access_token)
      : undefined;
  if (typeof token !== "string") throw new Error("Registry token response did not contain a token");
  return `Bearer ${token}`;
}

function fetchWithTimeout(url: URL, authorization: string | undefined, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    headers: { accept: "application/json", ...(authorization ? { authorization } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_PAGE_BYTES) throw new Error(`Registry response exceeded ${MAX_PAGE_BYTES} bytes`);
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_PAGE_BYTES) throw new Error(`Registry response exceeded ${MAX_PAGE_BYTES} bytes`);
  return body;
}

interface CacheEntry {
  checkedAt: number;
  latest: string | undefined;
}

export interface LatestLookupResult {
  latest: Map<string, string>;
  failures: number;
  lookups: number;
}

/** Resolves the newest matching tag per image, caching results (including failures) for `ttlMs`. */
export class LatestVersionResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly options: {
      ttlMs: number;
      timeoutMs: number;
      concurrency?: number;
      exclude?: RegExp[];
      listTags?: TagLister;
      logger?: Pick<Console, "error">;
      now?: () => number;
    },
  ) {}

  async resolve(images: Iterable<string>): Promise<LatestLookupResult> {
    const now = (this.options.now ?? Date.now)();
    const listTags = this.options.listTags ?? listRegistryTags;
    const logger = this.options.logger ?? console;
    const unique = [...new Set(images)];

    const staleByRepository = new Map<string, Array<{ image: string; reference: ImageReference }>>();
    for (const image of unique) {
      const cached = this.cache.get(image);
      if (cached && now - cached.checkedAt < this.options.ttlMs) continue;
      const reference = parseImageReference(image);
      const excluded = this.options.exclude?.some((pattern) => pattern.test(image)) ?? false;
      if (excluded || !reference || !parseVersionTag(reference.tag)) {
        this.cache.set(image, { checkedAt: now, latest: undefined });
        continue;
      }
      const key = `${reference.registry}/${reference.repository}`;
      staleByRepository.set(key, [...(staleByRepository.get(key) ?? []), { image, reference }]);
    }

    let failures = 0;
    const repositories = [...staleByRepository.values()];
    const worker = async () => {
      for (let group = repositories.shift(); group; group = repositories.shift()) {
        const reference = group[0]?.reference;
        if (!reference) continue;
        let tags: string[] | undefined;
        try {
          tags = await listTags(reference.registry, reference.repository, this.options.timeoutMs);
        } catch (error) {
          failures += 1;
          logger.error(
            `Latest-version lookup failed for ${reference.registry}/${reference.repository}: ${errorMessage(error)}`,
          );
        }
        for (const { image, reference: imageReference } of group) {
          this.cache.set(image, {
            checkedAt: now,
            latest: tags ? newestMatchingTag(imageReference.tag, tags) : undefined,
          });
        }
      }
    };
    const lookups = staleByRepository.size;
    await Promise.all(Array.from({ length: Math.max(1, this.options.concurrency ?? 4) }, worker));

    const latest = new Map<string, string>();
    for (const image of unique) {
      const value = this.cache.get(image)?.latest;
      if (value) latest.set(image, value);
    }
    for (const image of this.cache.keys()) {
      if (!unique.includes(image)) this.cache.delete(image);
    }
    return { latest, failures, lookups };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
