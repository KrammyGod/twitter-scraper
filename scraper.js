require('dotenv/config');
const { chromium } = require('playwright');

/**
 * @type {import('playwright').Browser}
 */
let browser = undefined;
/**
 * @type {import('playwright').BrowserContext}
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
 * @returns {Promise<string[]>}
 */
async function scrape(page, url) {
    // Up to 5 seconds to load the page.
    await page.goto(url, { timeout: 5000 });
    const route = page.url();
    if (!route.startsWith('https://twitter.com') && !route.startsWith('https://x.com')) {
        return [url];
    }
    // Wait up to 5 seconds for the main photo to load.
    await page.waitForSelector('div[data-testid="tweetPhoto"]', { timeout: 5000 });
    // Check how many photos there are, and click on first one
    // The first cellInnerDiv is the original tweet, the rest are replies
    const tweetPhotos = page.getByTestId('cellInnerDiv').first().locator('a').filter({ has: page.getByTestId('tweetPhoto') });
    await tweetPhotos.first().click({ timeout: 2000 });
    // Keep scrolling through all the photos to load them all
    let nav = page.getByLabel('Next slide');
    // Wait for the navigation button to appear if there is one.
    // Timeout after 2 seconds (single photo)
    const canNav = await nav.waitFor({ timeout: 2000 }).then(() => true).catch(() => false);
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
    return urls;
}

/**
 * Wrapper that never throws.
 * @param {string} url
 * @returns {Promise<string[]>}
 */
exports.getImageUrl = async (url) => {
    // This ensures we always close the page, regardless of errors.
    const page = await context.newPage();
    const urls = [url];
    try {
        urls.splice(0, 1, ...await scrape(page, url));
    } catch (e) {
        // Log out the error instead of stderr to avoid pm2 spam.
        console.log(e);
    } finally {
        await page.close();
        return urls;
    }
}
