# version-exporter

A small Node.js exporter that periodically reads application versions from JSON APIs or discovers
container image tags from the Kubernetes or Docker API, then exposes the results for Prometheus. It has no
database or dashboard; Prometheus stores the time series.

## Configuration

Copy [config.example.json](./config.example.json) to `config.json` and set `CONFIG_FILE` to its
path. Configuration is validated at startup, and invalid configuration stops the process with a
useful error. The file is suitable for mounting from a Kubernetes ConfigMap; do not put credentials
in committed configuration.

Each HTTP target requires a unique `name`, a human-readable `label`, a `url`, and a JSONPath
expression that resolves to exactly one string or number. The target's `every`, `timeout`, `retries`,
and `backoff` can override the defaults. Durations accept positive `ms`, `s`, `m`, `h` (or `hr`),
and `d` values. Retry delays use exponential backoff and are capped at 60 seconds.

Groups control concurrency. A `serial` group runs one target at a time; a `parallel` group runs up
to its configured `concurrency` (or the default concurrency). Targets without a group use the
implicit `default` parallel group. A target is never run concurrently with itself; ticks that occur
while it is queued or running are coalesced.

The `kubernetes` target lists pods across all namespaces using the pod's service-account token and
CA, and reports tags from regular, init, and ephemeral container image references. Untagged images
are reported as `latest`. This target needs only the `list` verb on core `pods`; grant it through a
read-only ClusterRole when running in Kubernetes.

Set `"nodes": true` on a `kubernetes` target to also report each node's OS and kubelet (this needs
`list` on core `nodes` too). Rows use the node name as `pod` and an empty `namespace`. Talos nodes report
`container="talos"` as `ghcr.io/siderolabs/installer:<version>` and `container="kubelet"` as
`ghcr.io/siderolabs/kubelet:<version>`; other distributions report only the kubelet, as
`registry.k8s.io/kube-apiserver:<version>`. With `latest` enabled those resolve to the newest Talos and
Kubernetes releases.

The `docker` target lists the running containers of one Docker Engine through its API. `endpoint`
defaults to `unix:///var/run/docker.sock`; `http://` and `https://` endpoints are also accepted, which
is the recommended setup: put [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
with only `CONTAINERS=1` and `IMAGES=1` in front of the socket instead of mounting it into the
exporter. Labels follow docker-compose: `namespace` is the compose project, `pod` the container name
and `container` the compose service (or the container name outside compose). The pulled digest comes
from the image's `RepoDigests`.

Every series carries a `system` label naming where the workloads run (a cluster or host name). Set
it with `defaults.system` or per target with `system`; it defaults to the machine's hostname, so a
container started with `--uts=host` reports its host.

Add `"latest": {}` to a `kubernetes` or `docker` target to also look up the newest available version of each
running image, using the registry's v2 API with anonymous bearer tokens (Docker Hub, ghcr.io, quay.io,
registry.k8s.io and similar public registries work):

- **Version tags** are compared against the repository's tag list. A tag is reduced to its *shape* —
  digit runs become `#` and commit-hash segments become `*` — and the highest tag with the same shape
  wins. So `16.4-alpine` (`#.#-alpine`) can resolve to `17.0-alpine` but never `17`, `17.0-bookworm` or
  `17.0-rc1-alpine`; `1.41.3-ls270` moves within `#.#.#-ls#`; and `2024.10.22-7ca5933` compares by date
  while ignoring the hash. Listing starts at the tag's literal prefix (e.g. `last=v`) so repositories
  with thousands of hash or signature tags stay within the page limit; registries that don't support
  that get a full listing.
- **Floating tags** with no numbers (`latest`, `preview-…`) are compared by digest: the digest the
  node actually pulled (from the pod's container status) against the registry's current digest for
  that tag (a `HEAD` request, which doesn't count against Docker Hub's pull limit). An up-to-date image
  reports the tag itself; a stale one reports `<tag>@sha256:<first 12 hex>` of the newer build.
- **Rebuilt version tags**: when a version tag is already the newest, its digest is compared the same
  way, so a tag that was re-pushed (e.g. a base-image rebuild under the same version) shows as
  `<tag>@sha256:<?>`. Set `checkDigests` to `floating` to skip this.

Options:

- `every` (default `6h`) — how long a successful result is cached. Failed lookups (e.g. rate limits,
  which are also retried with backoff) are retried after at most 10 minutes.
- `concurrency` (default `4`) — parallel registry lookups.
- `exclude` (default `[]`) — regular expressions matched against the full image reference; matching
  images are never looked up.
- `ignoreTags` (default `[]`) — regular expressions matched against `<registry>/<repository>:<tag>`
  (Docker Hub images are normalized to `docker.io/library/<name>` or `docker.io/<org>/<name>`); matching
  candidate tags are never chosen as latest. Use this for repositories with stray legacy tags, e.g.
  `"linuxserver/qbittorrent:(20\\.04\\.1|14\\.3\\.9)$"`.
- `upstreams` (default `[]`) — `{ "match": "<regex>", "repository": "<repo>" }` entries; images whose
  full reference matches are looked up in `repository` (no tag) instead, comparing tags only. Use this
  for mirrors or private rebuilds of a public image, e.g. mapping `^registry.lan:5000/gha-runner:` to
  `myoung34/github-runner`.
- `checkDigests` (default `all`) ? `all` compares digests for floating tags and for version tags that
  are already the newest; `floating` compares floating tags only. Upstream-mapped images are never
  compared by digest.

Registry lookups need outbound HTTPS access to the registries your images come from.

Set top-level `"push": { "url": "..." }` to also POST the metrics in Prometheus text format to
`url` every `every` (default `1m`, with a `timeout`, default `10s`) — for example VictoriaMetrics'
`/api/v1/import/prometheus` — when nothing can scrape the exporter. Credentials in the URL are rejected.

## Metrics and endpoints

- `GET /metrics` — Prometheus exposition format.
- `GET /healthz` — process liveness check.
- `version_exporter_<target_name>_version{system,label,version,...} 1` — current version for each target.
- `version_exporter_target_up{target,system}` — whether the latest scrape succeeded.
- `version_exporter_target_last_scrape_timestamp_seconds{target,system}` — timestamp of the latest attempt.
- `version_exporter_target_scrape_duration_seconds{target,system}` — duration of the latest attempt.
- `version_exporter_target_scrapes_total{target,system,result}` — scrape attempts by outcome.
- `version_exporter_image_latest{target,system,image,latest_version} 1` — newest matching registry tag
  for a running image (Kubernetes and Docker targets with `latest` enabled). Join it to the version
  metric on `system` and `image`.
- `version_exporter_latest_lookups_total{target,system,result}` — registry repository lookups by outcome.
- `version_exporter_pushes_total{system,result}` — metric pushes by outcome (only with `push`).

Other tools can push rows in the same schema (`version_exporter_<name>_version` plus
`version_exporter_image_latest` with matching `system` and `image`) for things the exporter can't
discover itself, such as hypervisor or NAS platform versions, and they appear alongside.

When Prometheus scrapes the exporter, enable `honor_labels` so the discovered `namespace`, `pod` and
`container` labels are kept rather than renamed to `exported_*`.

Target names are normalized to lowercase Prometheus metric-name suffixes. Names that normalize to
the same metric are rejected during startup.

## Run locally

Requires Node.js 22 or newer and TypeScript is built as part of the test/build commands.

```sh
npm ci
cp config.example.json config.json
npm run build
npm start
```

Set `PORT` to change the metrics port (default `9090`). Kubernetes discovery is available only
inside a pod with the service-account token and CA mounted; Docker discovery needs access to a
Docker API endpoint.

## Container

Build and run the image with a mounted configuration file:

```sh
docker build -t version-exporter .
docker run --rm -p 9090:9090 \
  -e CONFIG_FILE=/etc/version-exporter/config.json \
  -v "$PWD/config.json:/etc/version-exporter/config.json:ro" \
  version-exporter
```

Run tests with `npm test`; it type-checks/builds the app and tests before running them.

## Publishing images

The GitHub Actions workflow at `.github/workflows/publish.yml` builds and tests TypeScript changes
for pull requests. On pushes to `main`, it publishes both `dev` and `latest` tags (and an immutable
commit-SHA tag) for `linux/amd64` and `linux/arm64` to GitHub Container Registry at `ghcr.io/<owner>/version-exporter`. Version tags
(`v*`) publish a matching image tag.

The workflow authenticates with its built-in `GITHUB_TOKEN`; no extra registry credentials or
Google Cloud configuration are needed. The publish job has `packages: write` permission. Configure
the package visibility in GitHub Packages as desired after its first publish.
