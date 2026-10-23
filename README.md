# version-exporter

A small Node.js exporter that periodically reads application versions from JSON APIs or discovers
container image tags from the Kubernetes API, then exposes the results for Prometheus. It has no
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

Add `"latest": {}` to a `kubernetes` target to also look up the newest available tag for each running
image. The exporter lists the image repository's tags through the registry's v2 API (anonymous
bearer tokens, so Docker Hub, ghcr.io, quay.io, registry.k8s.io and similar public registries work)
and picks the highest tag with the same shape as the running one: same `v` prefix, same number of
version components, and same suffix. For example, `16.4-alpine` can resolve to `17.0-alpine`, but not
to `17` or `17.0-bookworm`. Tags that aren't versions (`latest`, commit hashes) and tags whose suffix
contains its own version number (`-rc1`, `-ls270`) are skipped. Options:

- `every` (default `6h`) — how long a repository's result is cached before it is looked up again.
- `concurrency` (default `4`) — parallel registry lookups.
- `exclude` (default `[]`) — regular expressions matched against the full image reference; matching
  images are never looked up. Use this for repositories whose tag history isn't monotonic (e.g.
  `"linuxserver/qbittorrent"`, which once used Ubuntu-numbered tags like `20.04.1`).

Registry lookups need outbound HTTPS access to the registries your images come from.

## Metrics and endpoints

- `GET /metrics` — Prometheus exposition format.
- `GET /healthz` — process liveness check.
- `version_exporter_<target_name>_version{label,version,...} 1` — current version for each target.
- `version_exporter_target_up{target}` — whether the latest scrape succeeded.
- `version_exporter_target_last_scrape_timestamp_seconds{target}` — timestamp of the latest attempt.
- `version_exporter_target_scrape_duration_seconds{target}` — duration of the latest attempt.
- `version_exporter_target_scrapes_total{target,result}` — scrape attempts by outcome.
- `version_exporter_image_latest{target,image,latest_version} 1` — newest matching registry tag for a
  running image (Kubernetes targets with `latest` enabled). Join it to the version metric on `image`.
- `version_exporter_latest_lookups_total{target,result}` — registry repository lookups by outcome.

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
inside a pod with the service-account token and CA mounted.

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
commit-SHA tag) to GitHub Container Registry at `ghcr.io/<owner>/version-exporter`. Version tags
(`v*`) publish a matching image tag.

The workflow authenticates with its built-in `GITHUB_TOKEN`; no extra registry credentials or
Google Cloud configuration are needed. The publish job has `packages: write` permission. Configure
the package visibility in GitHub Packages as desired after its first publish.
