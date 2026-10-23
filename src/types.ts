export interface ConfigDefaults {
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
}

export interface KubernetesTargetInput extends TargetInputBase {
  type: "kubernetes";
  url?: never;
  jsonpath?: never;
  latest?: Partial<LatestLookupConfig>;
}

export type TargetInput = HttpTargetInput | KubernetesTargetInput;

interface ConfiguredTargetBase extends TargetInputBase {
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
  latest?: LatestLookupConfig;
}

export type ConfiguredTarget = HttpTarget | KubernetesTarget;

export interface ConfigInput {
  defaults?: Partial<ConfigDefaults>;
  groups?: Array<Pick<GroupConfig, "name" | "mode"> & { concurrency?: number }>;
  targets: TargetInput[];
}

export interface ExporterConfig {
  defaults: ConfigDefaults;
  groups: GroupConfig[];
  targets: ConfiguredTarget[];
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

export interface KubernetesPodList {
  metadata?: {
    continue?: string;
  };
  items: KubernetesPod[];
}
