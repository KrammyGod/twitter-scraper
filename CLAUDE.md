# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm i                      # install
npm run playwrightSetup    # download the chromium binary (separate from npm i)
npm start                  # node --env-file-if-exists=.env .  (needs Node >= 22.9)

docker build -t twitter-scraper .
docker run --rm -p 5000:5000 --shm-size=1g -e TWITTER_AUTH_TOKEN=... twitter-scraper

npx kustomize build kustomize/overlays/prod   # render manifests; no cluster needed
kubectl apply -k kustomize/overlays/prod      # manual deploy
```

There is **no test framework, no linter, and no build step** — the source runs as
written. Do not invent an `npm test`; if a change needs verifying, see below.

### Verifying changes without a browser

`npm run playwrightSetup` needs network access to the Playwright CDN, and the
image only builds for `linux/arm64`, so neither works in every environment. To
exercise the HTTP layer, the allow-list, `/healthz` and shutdown, hand-write a
stub at `node_modules/playwright-chromium/` exporting a `chromium.launch()` that
returns an object with `isConnected`, `close` and `newContext`. That covers
everything except the scraping selectors themselves, which need a real browser
and a real tweet.

## Architecture

Two source files, and the split matters:

- **`scraper.js`** owns the browser. One `Browser` and one `BrowserContext` are
  launched at process start and shared by every request — module-level state, not
  per-request. `getImageUrl()` opens and closes a `Page` per call and is a
  deliberate never-throws wrapper (`return` inside `finally`), so a failed scrape
  yields `{ imgs: [], data: undefined }` rather than an error.
- **`index.js`** is a bare `http.createServer`. Requests arriving before the
  browser is up park on a one-shot `ready` EventEmitter rather than failing.

Consequences of the shared-browser design that shape everything else: the process
is single-tenant and stateful, so it runs as exactly one replica with `Recreate`;
a dead browser is unrecoverable in-process, which is why `/healthz` reports
`browser.isConnected()` and lets Kubernetes restart the pod.

**Response shape is keyed off `User-Agent: node`** — that exact string gets JSON,
anything else gets a debug PNG screenshot with the links in an `imgs` header.
The in-cluster consumer relies on this.

**Two layers of host checking, both needed.** `ALLOWED_HOSTS` is consulted
*before* `page.goto()`; the `route.startsWith(...)` check after navigation
catches where a redirect landed. This is paired with `chromiumSandbox: false` —
the allow-list is what makes disabling chromium's own sandbox acceptable, so
weakening either one requires revisiting the other.

**The scraping selectors are twitter's internal `data-testid` values**
(`tweetPhoto`, `cellInnerDiv`) and the `Next slide` aria label. They break
whenever twitter changes its markup, and nothing in CI will catch it — an empty
`imgs` array with a green `/healthz` is the symptom.

## Deployment

Ships as an image to `ghcr.io/krammygod/twitter-scraper`, running on the k3s
cluster defined in **`KrammyGod/home-infra`** — three arm64 Orange Pi SBCs
(`opi` control plane, `omc`, `oopi`). Read that repo's `README.md` before
changing anything under `kustomize/`; its conventions (GHCR images,
`kustomize/overlays/prod` as the future Flux path, sealed-secrets for
credentials) are what this repo follows.

`.github/workflows/publish.yml` on push to `main`: builds `linux/arm64` natively
on `ubuntu-24.04-arm`, pushes `:latest` and `:<sha>`, rewrites the overlay to the
SHA, then pipes rendered manifests over SSH to `kubectl apply -f -` on opi.

Things that will silently or confusingly break:

- **`newTag: latest` in `kustomize/overlays/prod/kustomization.yaml` is
  load-bearing for CI.** The deploy job greps for that literal line before
  `sed`-ing it. The grep exists because `sed` exits 0 on no match; keep it if you
  restructure, or deploys will ship `latest` forever while reporting success.
- **The image is arm64-only.** It will not run on an x86 laptop without QEMU.
- **`readOnlyRootFilesystem: true`** — only `/tmp` and `/dev/shm` are writable.
  `HOME=/tmp` in the Dockerfile is what lets chromium write its profile; anything
  new that needs disk needs a volume.
- **`/dev/shm` is a memory-backed `emptyDir`** and counts against the container's
  memory limit, so the two numbers are linked, not independent.
- The `twitter-scraper-auth` Secret is **not in this repo** — it is sealed
  against the live cluster with `kubeseal`. See README, "The auth token".

Deviating from the documented choices in README's *Design decisions* (no CPU
limit, `Recreate` over `RollingUpdate`, no Ingress, `NotIn [oopi]` scheduling)
means overriding a stated rationale — read it first.
