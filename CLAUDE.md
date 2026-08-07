# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A one-endpoint HTTP server that drives a headless chromium to pull the raw image
URLs out of a tweet. Deployed to a k3s cluster by Flux, from manifests rendered
in CI — never by `kubectl apply`.

**This repository is public.** Comments, docs and commit messages must describe
this service and nothing else: no infrastructure topology, no other workloads,
no capacity figures, no hostnames, no addresses. The one node name in
`kustomize/base/deployment.yaml` is the exception the scheduler requires.

## Commands

```sh
npm run playwrightSetup                      # once — downloads chromium
npm start                                    # reads .env
npm audit                                    # must stay at 0

kubectl kustomize kustomize/overlays/prod    # the only local check that exists
node --check index.js                        # ... and this
```

There is **no test suite, no linter and no formatter**, and CI adds none —
`.github/workflows/deploy.yml` calls the shared pipeline and nothing else. A
broken `index.js` reaches the cluster and crash-loops there. Rendering the
overlay and reading the diff is the whole of the local safety net for manifests.
Say plainly when something is unverified.

`.env` needs `TWITTER_AUTH_TOKEN` — the `auth_token` cookie from a logged-in
browser. Without it the scrape returns an empty list rather than failing, since
twitter serves a login wall and no `tweetPhoto` element ever appears.

## Architecture

Two files. `index.js` is the server; `scraper.js` owns the browser and is usable
as a module on its own.

**One browser, one context, one page per request.** `Scraper.start()` launches
chromium at boot and the process holds it for its whole life; each request opens
a page and closes it in a `finally`. Launching per request would cost seconds
and is what the readiness gate exists to avoid.

**Requests are queued behind startup, not rejected.** `index.js` holds an
EventEmitter that requests await when `started` is false, so a request arriving
during launch waits instead of 503-ing. The probe path is the exception — see
below.

**`getImageUrl` never throws.** It logs to stdout (not stderr) and returns
`{ imgs: [], data: undefined }`. Every failure mode — a timeout, a login wall, a
deleted tweet — looks identical to a tweet with no images. That is deliberate,
and it is also why a broken deploy is invisible from the response alone.

**The response shape depends on the `User-Agent`.** `node` gets JSON; anything
else gets a PNG screenshot with the URLs in an `imgs` header, for debugging by
hand in a browser. The consumer relies on undici sending `user-agent: node` by
default — changing that header on the client silently switches it to the
screenshot path.

**`/healthz` is the only routed path.** Everything else is treated as a scrape
regardless of path, which is what lets the ingress publish a prefix without a
StripPrefix middleware.

### Health

`/healthz` reports `started && Scraper.isConnected()`, so it goes 503 again if
chromium dies rather than reporting a server that answers every request with an
empty list. Three probes hang off it:

- **startupProbe** — a long budget, because launching chromium on this hardware
  is slow. It is what stops the liveness probe killing the pod mid-launch.
- **readinessProbe** — keeps the Service pointed away until the browser is up.
- **livenessProbe** — restarts the pod when chromium dies under it.

## Traps

- **The build is `linux/arm64` only.** The Dockerfile pins the arm64 *manifest*
  digest, not the multi-arch index digest, so a build on any other architecture
  fails outright instead of producing an image the cluster cannot run. `docker
  build` does not work on an x86 machine, by design.
- **`PLAYWRIGHT_BROWSERS_PATH` must stay set in the Dockerfile.** The default is
  `$HOME/.cache/ms-playwright`, and the browser is downloaded as root while the
  container runs as uid 2000 — the image would build clean and fail at launch
  with "Executable doesn't exist".
- **The browser download comes from `npm ci`, not from the `playwright install`
  line.** `playwright-chromium` fetches it in its own postinstall; the explicit
  install runs for `--with-deps`, the apt packages chromium links against.
  Switching the dependency to `playwright-core` removes the download with no
  other visible change.
- **`/dev/shm` is 64 MiB in a container** and chromium renders into it. The
  Deployment mounts an emptyDir over it; without that a multi-image tweet takes
  down the tab, which surfaces as an empty result, not an error.
- **Playwright's `chromiumSandbox` defaults to `false`** (unlike Puppeteer). The
  pod is the isolation boundary. Enabling it needs capabilities the pod does not
  have.
- **The cookie is set for `.twitter.com` only**, while `scrape()` accepts both
  `twitter.com` and `x.com` URLs. Pre-existing, and unverified against the live
  site — if scrapes come back empty for `x.com` links, suspect this first.
- **`.dockerignore` feeds the image tag.** CI hashes the git blob IDs of
  everything entering the build context to decide whether to rebuild, so adding
  a path there changes the tag. Keep `kustomize/`, `docs/` and `CLAUDE.md` out
  of the context — none of them belong in the image.
- **The Deployment is `Recreate`, and must stay that way** while every replica
  is pinned to one node: a surge pod means two chromiums on that node.
- **Changing the SealedSecret does not restart pods.** `secretKeyRef` is read
  once at pod start and there is no content hash to force a roll. `rollout
  restart` by hand after rotating the token.

## Deployment

CI builds the image, renders `kustomize/overlays/prod` with it pinned, and
pushes the result as an OCI artifact; the cluster pulls and applies it. A merge
to `main` is the deploy, and CI going green means the artifact was pushed —
whether it applied is only visible in the cluster.

The `image:` field in the manifests is a bare name with no tag; the tag is
written at publish time, so editing it by hand accomplishes nothing. The
namespace and the image name are both `twitter-scraper` and the workflow passes
them; the manifest artifact name is derived from the namespace, not configured.

`TWITTER_AUTH_TOKEN` lives in `kustomize/overlays/prod/sealed-secret.yaml`,
encrypted to the cluster's key and scoped to this namespace *and* this secret
name — renaming either means re-sealing. The plaintext stays in `.env`; see
README.md § Rotating the auth token.

`docs/` is gitignored and local-only.
