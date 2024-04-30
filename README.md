# Twitter Scraper
A very simple and basic scraping script that will retrieve all raw image links from a specific tweet.

This project is mostly for personal purposes, but feel free to use it if you want to.

## Use instructions:
1. Clone this repository
2. Install requirements: `npm i`
3. Get your twitter token (look for `auth_token` in cookies) and put it in the `.env` file under `TWITTER_AUTH_TOKEN` (see `.env.example`).
4. Run `npx playwright install` to install the browser binaries.
5. Run `npm start` to start the server, or you can simply use `scraper.js` as a module.

## Advanced deployment
There is a configuration for deploying to a server via PM2 (see `ecosystem.config.js`). Example of how I deploy it is available in github actions.
