const { test } = require('@playwright/test');
const { expect } = require('./helpers');

test.use({ serviceWorkers: 'allow' });

test('app loads and runs offline after the first visit', async ({ page, context }) => {
  await page.route('**/fonts.googleapis.com/**', r => r.abort());
  await page.goto('/index.html');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Let the service worker finish caching
  await page.waitForTimeout(1000);
  const cached = await page.evaluate(async () => {
    const keys = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) keys.push(new URL(req.url).pathname);
    }
    return keys;
  });
  for (const file of ['/index.html', '/css/styles.css', '/js/rhythms.js', '/js/data.js', '/js/app.js']) {
    expect(cached, file).toContain(file);
  }
  // Make sure files come from the service worker, not the browser's HTTP cache
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#zollDevice')).toBeVisible();
  await page.click('.quick-rhythm-panel [data-rhythm="svt"]');
  expect(await page.evaluate(() => state.rhythm)).toBe('svt');
  expect(await page.$eval('.main-header img', i => i.naturalWidth)).toBeGreaterThan(0);
});
