# Twitter Scraper
A very simple and basic scraping script that will retrieve all raw image links
from a specific tweet. Used by my [Discord bot](https://github.com/KrammyGod/pingbot).

This project is mostly for personal purposes, but feel free to use it if you want to.

Runs on a k3s cluster as one pod holding one headless chromium. Deploys are
pull-based — CI builds the image and renders the manifests, and the cluster
applies them itself.

## Use instructions:
1. Clone this repository
2. Install requirements: `npm i`
3. Get your twitter token (look for `auth_token` in cookies) and put it in the `.env` file under `TWITTER_AUTH_TOKEN` (see `.env.example`).
4. Run `npm run playwrightSetup` to install the browser binaries.
5. Run `npm start` to start the server, or you can simply use `scraper.js` as a module.

## API

| Route | Response |
|---|---|
| `GET /?url=<tweet>` | `{"imgs": [...]}` when the `User-Agent` is `node`, otherwise a PNG screenshot of the tweet with the same list in an `imgs` header — the debugging view. |
| `GET /healthz` | `200` once chromium is up, `503` until then and again if it dies. |

Everything but `/healthz` is treated as a scrape, so the path the request
arrives on does not matter.

## Deployment

The pipeline lives in [actions-system](https://github.com/KrammyGod/actions-system);
`.github/workflows/deploy.yml` only names the namespace and the image. A push to
`main` builds `ghcr.io/krammygod/twitter-scraper`, renders `kustomize/overlays/prod`
with that image pinned, and pushes the result to
`ghcr.io/krammygod/twitter-scraper-manifests:main`. Flux pulls it within a
minute. Pull requests build a `-dev` image and render, but publish nothing.
