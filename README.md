# Twitter Scraper

A very simple and basic scraping script that will retrieve all raw image links
from a specific tweet.

This project is mostly for personal purposes, but feel free to use it if you want
to.

Runs as a single pod on the k3s cluster in
[`home-infra`](https://github.com/KrammyGod/home-infra). It used to run under pm2
on `opi`; see [Design decisions](#design-decisions) for what changed and why.

## Use instructions

1. Clone this repository
2. Install requirements: `npm i`
3. Get your twitter token (look for `auth_token` in cookies) and put it in the
   `.env` file under `TWITTER_AUTH_TOKEN` (see `.env.example`).
4. Run `npm run playwrightSetup` to install the browser binaries.
5. Run `npm start` to start the server, or you can simply use `scraper.js` as a
   module.

`npm start` uses `--env-file-if-exists`, so the same command works with a `.env`
on a laptop and with plain environment variables in a container.

### The API

| Path | Response |
|---|---|
| `/?url=<tweet>` with `User-Agent: node` | `{"imgs": [...]}` |
| `/?url=<tweet>` from anything else | a debug PNG screenshot, image links in the `imgs` header |
| `/healthz` | `200 ok`, or `503` while the browser is down |

Only `twitter.com` and `x.com` URLs are scraped. Anything else returns an empty
`imgs` list without the browser ever loading it.

## Running it in Docker

```sh
docker build -t twitter-scraper .
docker run --rm -p 5000:5000 \
  --shm-size=1g \
  -e TWITTER_AUTH_TOKEN=... \
  twitter-scraper
```

`--shm-size` is not optional. The default 64 MB `/dev/shm` is where chromium tab
crashes and `Target closed` errors come from; the Kubernetes manifests mount a
real one for the same reason.

## Deploying to the cluster

Pushing to `main` builds `ghcr.io/krammygod/twitter-scraper` on a native arm64
runner, then applies `kustomize/overlays/prod` over SSH and waits for the
rollout. Nothing else is needed for an ordinary change.

```
kustomize/
  base/       namespace · deployment · service
  overlays/
    prod/     the image tag, and the path Flux would be pointed at later
```

### First-time setup

These four steps are only needed once, before the first deploy.

**1 · Make the GHCR package public.** The first push creates
`ghcr.io/krammygod/twitter-scraper` as a private package, and the cluster has no
credentials for it — pods sit in `ImagePullBackOff` with `denied`. Either flip
the package to public under *Packages → twitter-scraper → Package settings*, or
seal a pull secret and add `imagePullSecrets` to the Deployment (the exact
`kubeseal` invocation for a `dockerconfigjson` is in home-infra's
`manifests/sealed-secrets/README.md`).

**2 · Create the auth token secret.** See [below](#the-auth-token).

**3 · Confirm the deploy secrets.** The workflow reuses `SSH_PRIVATE_KEY`,
`SSH_KNOWN_HOSTS`, `SSH_USER` and `SSH_HOST` from the pm2 era. `DEPLOY_PATH` is
no longer read and can be deleted — the runner renders the manifests and opi
never needs a checkout.

**4 · Apply once by hand** if you want the Deployment to exist before the first
push:

```sh
kubectl apply -k kustomize/overlays/prod
```

### The auth token

The pod reads `TWITTER_AUTH_TOKEN` from a Secret named `twitter-scraper-auth`.
It is deliberately not in this repo: sealing needs the live cluster's public key,
so it cannot be committed ahead of the cluster existing.

```sh
kubectl create namespace twitter-scraper   # if applying the secret first

kubectl create secret generic twitter-scraper-auth \
  --namespace twitter-scraper \
  --dry-run=client \
  --from-literal=TWITTER_AUTH_TOKEN='<auth_token cookie value>' \
  -o yaml \
| kubeseal --format yaml > kustomize/overlays/prod/sealed-secret.yaml

kubectl apply -f kustomize/overlays/prod/sealed-secret.yaml
```

The result is safe to commit; add it to `resources:` in the prod overlay once it
exists. A SealedSecret only decrypts into the namespace and name it was sealed
for, so keep both as above.

Twitter expires `auth_token` on its own schedule. When scrapes start returning
empty lists but `/healthz` is green, re-seal a fresh cookie and
`kubectl -n twitter-scraper rollout restart deploy/twitter-scraper`.

### Operating it

```sh
kubectl -n twitter-scraper get pods -o wide
kubectl -n twitter-scraper logs deploy/twitter-scraper -f
kubectl -n twitter-scraper rollout undo deploy/twitter-scraper   # previous image
kubectl -n twitter-scraper get deploy twitter-scraper -o jsonpath='{..image}'
```

There is no Ingress. To look at a debug screenshot from a laptop:

```sh
kubectl -n twitter-scraper port-forward svc/twitter-scraper 5000:5000
open 'http://localhost:5000/?url=https://x.com/…'
```

In-cluster consumers use
`http://twitter-scraper.twitter-scraper.svc.cluster.local:5000/?url=…`.

---

# Design decisions

**No Ingress, ClusterIP only.** The pod holds a logged-in twitter session, and
every request spends it. A publicly reachable scrape-on-demand endpoint is a way
for a stranger to get the account rate-limited or locked. The only consumer is
another workload in the same cluster, which does not need to leave it.

**One replica, `Recreate`.** `RollingUpdate` would briefly hold two chromium
instances on one node, doubling the peak memory of the heaviest thing in the pod
on a 3.9 GiB SBC. The consumer retries, so a few seconds of downtime is cheaper
than the headroom.

**Scheduled anywhere except `oopi`.** That node is an Orange Pi 3 LTS with 1.9
GiB already running postgres, nginx and nfs-server; chromium peaking near 700 MiB
there is how postgres gets OOM-killed. Written as `NotIn [oopi]` rather than an
allow-list, so a fourth node is eligible by default.

**A memory limit but no CPU limit.** Breaching a memory limit is an OOMKill, so
1 GiB is headroom over a much smaller idle footprint rather than an allocation —
and the memory-backed `/dev/shm` counts against that same number, which is why it
is capped at 128 MiB. CPU is left uncapped because throttling only makes each
scrape slower and the caller's 5 s page-load timeout more likely to fire, while
CPU contention resolves itself.

**`/healthz` reports the browser, not the HTTP server.** A crashed or
disconnected chromium never recovers on its own — the process would happily keep
answering with empty results forever. Reporting `browser.isConnected()` is what
turns that into a pod restart. All three probes share the endpoint; the startup
probe allows two minutes, because chromium's first launch on an SBC is slow and a
tight budget turns a slow boot into a crash loop.

**Hosts are checked before `goto`, not after.** The old code navigated to
whatever URL a caller supplied and only then compared `page.url()` against
twitter — so an arbitrary page was fully rendered before being rejected. With
chromium's own sandbox disabled (below) that is not a trade worth keeping. The
post-navigation check stays, since an allow-list cannot see where a redirect ends
up.

**`chromiumSandbox: false`, and the pod is the boundary instead.** Chromium's
setuid/namespace sandbox does not come up reliably in an unprivileged container,
and the usual fix — a custom seccomp profile plus `SYS_ADMIN` — grants the pod
more than the sandbox was buying back. What is in place instead: non-root user,
read-only root filesystem, all capabilities dropped, `RuntimeDefault` seccomp, no
service account token, and an allow-list that means the only pages this browser
ever renders are twitter's.

**`node:22-bookworm-slim` plus `playwright install chromium`, not the official
Playwright image.** That image ships chromium, firefox and webkit and lands
around 2 GB. This project only ever launches chromium, and the cluster is three
SBCs.

**The auth cookie is set for `.x.com` as well as `.twitter.com`.** A cookie
scoped to `.twitter.com` is not sent to `x.com`, so scraping an `x.com` URL —
which is where every link redirects now — was silently running logged out.

**The image is deployed by SHA tag, not `latest`.** `latest` stays in the overlay
so a clean checkout can `kubectl apply -k`, but CI pins the commit SHA before
applying, which makes what is running traceable to a commit and `rollout undo`
meaningful. The workflow greps for the line before rewriting it, because `sed`
exits 0 when it matches nothing and would otherwise ship `latest` forever while
reporting success.

**Deploy is still SSH, not Flux.** home-infra's Flux layout is designed but not
bootstrapped, and the overlay lives at `kustomize/overlays/prod` so that adopting
it later is a `GitRepository` + `Kustomization` pair in home-infra and nothing
here. Until then the runner renders and opi applies, which at least means opi
never holds a checkout of this repo.

**Why pm2 went away.** `pm2 deploy` pushed source to a directory on the box and
ran `npm i && playwright install` there, so a deploy could report success and
leave a half-installed app behind, and the node's global playwright browsers had
to stay in step with `package.json` by hand. An image has neither problem. The
pm2-specific `process.on('message', 'shutdown')` handler went with it; `SIGTERM`
is what Kubernetes sends.
