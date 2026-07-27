const { chromium } = require('playwright-chromium');

/**
 * Hosts we are willing to point a browser at.
 *
 * The old code navigated first and checked `page.url()` afterwards, which meant
 * an arbitrary caller-supplied URL was fully rendered before being rejected.
 * That was survivable behind pm2 on a trusted box; it is not something to keep
 * now that the browser runs with `chromiumSandbox: false` (see below). Checking
 * before `goto` keeps the same contract — a non-twitter URL yields no images —
 * without ever loading the page.
 *
 * The post-navigation check further down still exists, because this one cannot
 * see where a redirect ends up.
 */
const ALLOWED_HOSTS = new Set([
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com',
    'x.com',
    'www.x.com',
    'mobile.x.com',
]);

/**
 * @type {import('playwright-chromium').Browser}
 */
let browser = undefined;
/**
 * @type {import('playwright-chromium').BrowserContext}
 */
let context = undefined;
/**
 * Must be called before calling getImageUrl.
 * @returns {Promise<void>}
 */
exports.start = async () => {
    browser = await chromium.launch({
        // Chromium's setuid/namespace sandbox does not come up reliably inside
        // an unprivileged container, and the usual workaround (a custom seccomp
        // profile plus SYS_ADMIN) hands the pod more privilege than the sandbox
        // was buying back. The pod is the isolation boundary instead: non-root
        // user, read-only root filesystem, every capability dropped, and — the
        // part that actually matters — ALLOWED_HOSTS above means the only pages
        // this browser ever renders are twitter's.
        chromiumSandbox: false,
    });
    context = await browser.newContext();
    // Both domains: twitter.com still serves the old links, x.com is where they
    // land. A cookie scoped to .twitter.com is not sent to x.com, so scraping an
    // x.com URL without this second entry silently runs logged out.
    await context.addCookies(['.twitter.com', '.x.com'].map(domain => ({
        name: 'auth_token',
        value: process.env.TWITTER_AUTH_TOKEN,
        domain,
        path: '/',
    })));
};

/**
 * Whether the browser is up and able to serve requests. Backs the container's
 * probes: a browser that has crashed or disconnected never recovers on its own,
 * so surfacing it lets Kubernetes restart the pod rather than leave it Ready and
 * failing every request.
 * @returns {boolean}
 */
exports.isHealthy = () => browser !== undefined && browser.isConnected();

/**
 * Must be called before closing server.
 * @returns {Promise<void>}
 */
exports.end = () => {
    // Shutdown can arrive before start() resolves — chromium takes a few seconds
    // to come up on an SBC, and a pod can be told to terminate inside that window.
    if (context === undefined) return Promise.resolve();
    return context.close().then(() => {
        browser.close();
    });
};

/**
 * Actual meat of this project.
 * @param {import('playwright').Page} page
 * @param {string} url
 * @returns {Promise<{ urls: string[], d: Buffer }>}
 */
async function scrape(page, url) {
    let host = undefined;
    try {
        host = new URL(url).host;
    } catch {
        // Not a URL at all.
        return { urls: [], d: Buffer.from([]) };
    }
    if (!ALLOWED_HOSTS.has(host)) {
        return { urls: [], d: Buffer.from([]) };
    }
    // Up to 5 seconds to load the page.
    await page.goto(url, { timeout: 5000 });
    const route = page.url();
    if (!route.startsWith('https://twitter.com') && !route.startsWith('https://x.com')) {
        return { urls: [], d: Buffer.from([]) };
    }
    // Wait a bit for the page to finish loading (network delays)
    await page.waitForTimeout(1500);
    // Wait up to 10 seconds for the main photo to load.
    await page.waitForSelector('div[data-testid="tweetPhoto"]', { timeout: 10_000 });
    // Taking screenshot allows debugging for that particular image
    const d = await page.screenshot();
    // Check how many photos there are, and click on first one
    // The first cellInnerDiv is the original tweet, the rest are replies
    const tweetPhotos = page.getByTestId('cellInnerDiv').first().locator('a').filter({ has: page.getByTestId('tweetPhoto') });
    await tweetPhotos.first().click({ timeout: 2000 });
    // Keep scrolling through all the photos to load them all
    let nav = page.getByLabel('Next slide');
    // Wait for the navigation button to appear if there is one.
    // Timeout after 2 seconds (single photo)
    const canNav = await nav.waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
    const urls = [];
    if (canNav) {
        while (await nav.count()) {
            await nav.click();
            nav = page.getByLabel('Next slide');
        }
        // Now that all the photos are loaded, we can grab them all at once.
        const multiplePhotos = page.locator('ul[role="list"] img');
        const count = await multiplePhotos.count();
        for (let i = 0; i < count; ++i) {
            const res = await multiplePhotos.nth(i).getAttribute('src');
            urls.push(res);
        }
    } else {
        // Single photo is simple.
        const res = await page.getByRole('img', { name: 'Image' }).first().getAttribute('src');
        urls.push(res);
    }
    return { urls, d };
}

/**
 * Wrapper that never throws.
 * @param {string} url
 * @returns {Promise<{ imgs: string[], data: Buffer }>}
 */
exports.getImageUrl = async (url) => {
    // This ensures we always close the page, regardless of errors.
    const page = await context.newPage();
    /**
     * @type {string[]}
     */
    const imgs = [];
    /**
     * @type {Buffer}
     */
    let data = undefined;
    try {
        let { urls, d } = await scrape(page, url);
        imgs.push(...urls);
        data = d;
    } catch (e) {
        // Log to stdout rather than throwing: a single unscrapeable tweet is not
        // a reason to fail the request path. Genuine browser death is caught by
        // isHealthy() and handled by the pod restarting.
        console.log(e);
    } finally {
        await page.close();
        return { imgs, data };
    }
}
