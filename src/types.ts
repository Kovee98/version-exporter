export interface ConfigDefaults {
  /** Value of the `system` label (cluster, host or appliance the versions belong to). */
  system: string;
  every: string;
  timeout: string;
  retries: number;
  backoff: string;
  concurrency: number;
}

export interface GroupConfig {
  name: string;
  mode: "serial" | "parallel";
  concurrency: number;
}

interface TargetInputBase {
  name: string;
  label: string;
  system?: string;
  group?: string;
  every?: string;
  timeout?: string;
  retries?: number;
  backoff?: string;
}

export interface HttpTargetInput extends TargetInputBase {
  type: "http";
  url: string;
  jsonpath: string;
}

export interface LatestLookupConfig {
  every: string;
  concurrency: number;
  exclude: string[];
  ignoreTags: string[];
  upstreams: Array<{ match: string; repository: string }>;
  /**
   * `all` also compares digests when the running version tag is already the newest, so a rebuilt tag
   * (e.g. `postgres:17.6` re-pushed with OS updates) is reported; `floating` only checks number-less tags.
   */
  checkDigests: "all" | "floating";
}

export interface KubernetesTargetInput extends TargetInputBase {
  type: "kubernetes";
  /** Also report each node's Talos and kubelet versions. Needs `list` on core `nodes`. */
  nodes?: boolean;
  url?: never;
  jsonpath?: never;
  latest?: Partial<LatestLookupConfig>;
}

export interface DockerTargetInput extends TargetInputBase {
  type: "docker";
  /** Docker Engine API endpoint: `unix:///var/run/docker.sock` (default) or `http(s)://host:port` (e.g. a socket proxy). */
  endpoint?: string;
  nodes?: never;
  url?: never;
  jsonpath?: never;
  latest?: Partial<LatestLookupConfig>;
}

export type TargetInput = HttpTargetInput | KubernetesTargetInput | DockerTargetInput;

interface ConfiguredTargetBase extends TargetInputBase {
  system: string;
  metricName: string;
  group: string;
  every: string;
  timeout: string;
  retries: number;
  backoff: string;
}

export interface HttpTarget extends ConfiguredTargetBase {
  type: "http";
  url: string;
  jsonpath: string;
}

export interface KubernetesTarget extends ConfiguredTargetBase {
  type: "kubernetes";
  nodes: boolean;
  latest?: LatestLookupConfig;
}

export interface DockerTarget extends ConfiguredTargetBase {
  type: "docker";
  endpoint: string;
  latest?: LatestLookupConfig;
}

export type ConfiguredTarget = HttpTarget | KubernetesTarget | DockerTarget;

export interface PushConfig {
  /** VictoriaMetrics `/api/v1/import/prometheus` (or any endpoint accepting the Prometheus text format). */
  url: string;
  every: string;
  timeout: string;
}

export interface ConfigInput {
  defaults?: Partial<ConfigDefaults>;
  groups?: Array<Pick<GroupConfig, "name" | "mode"> & { concurrency?: number }>;
  targets: TargetInput[];
  push?: Partial<PushConfig> & Pick<PushConfig, "url">;
}

export interface ExporterConfig {
  defaults: ConfigDefaults;
  groups: GroupConfig[];
  targets: ConfiguredTarget[];
  push?: PushConfig;
}

export interface VersionResult {
  version: string;
  namespace: string;
  pod: string;
  container: string;
  image: string;
  /** Manifest digest the container runtime actually pulled (from pod status), when known. */
  digest?: string;
}

export interface HttpRequestOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  ca?: string | Buffer;
  maxResponseBytes?: number;
  /** Unix domain socket to connect to instead of the URL's host (e.g. the Docker socket). */
  socketPath?: string;
}

export type JsonRequester = (url: string | URL, options: HttpRequestOptions) => Promise<unknown>;

export interface PodContainer {
  name?: string;
  image?: string;
}

export interface KubernetesPod {
  metadata?: {
    namespace?: string;
    name?: string;
  };
  spec?: {
    initContainers?: PodContainer[];
    containers?: PodContainer[];
    ephemeralContainers?: PodContainer[];
  };
  status?: {
    initContainerStatuses?: PodContainerStatus[];
    containerStatuses?: PodContainerStatus[];
    ephemeralContainerStatuses?: PodContainerStatus[];
  };
}

export interface PodContainerStatus {
  name?: string;
  imageID?: string;
}

export interface KubernetesNode {
  metadata?: { name?: string };
  status?: { nodeInfo?: { osImage?: string; kubeletVersion?: string } };
}

export interface KubernetesNodeList {
  metadata?: { continue?: string };
  items: KubernetesNode[];
}

export interface KubernetesPodList {
  metadata?: {
    continue?: string;
  };
  items: KubernetesPod[];
}
