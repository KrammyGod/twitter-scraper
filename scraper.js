const { chromium } = require('playwright-chromium');

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
    browser = await chromium.launch();
    context = await browser.newContext();
    await context.addCookies([{
        name: 'auth_token',
        'value' : process.env.TWITTER_AUTH_TOKEN,
        domain: '.twitter.com',
        path: '/'
    }]);
};

/**
 * Must be called before closing server.
 * @returns {Promise<void>}
 */
exports.end = () => {
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
        // Log out the error instead of stderr to avoid pm2 spam.
        console.log(e);
    } finally {
        await page.close();
        return { imgs, data };
    }
}
