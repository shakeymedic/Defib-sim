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
  for (const file of ['/index.html', '/instructor.html', '/css/styles.css', '/css/instructor.css', '/js/rhythms.js', '/js/data.js', '/js/link.js', '/js/app.js', '/js/instructor.js']) {
    expect(cached, file).toContain(file);
  }
  // Visiting the instructor window online must not replace the cached simulator page
  const code = await page.locator('#sessionCodeDisplay').textContent();
  const visit = await context.newPage();
  await visit.goto(`/instructor.html?session=${code}`);
  await expect(visit.locator('#joinPanel')).toBeHidden();
  const cachedPage = path => page.evaluate(async p => {
    const r = await caches.match(p);
    return r ? r.text() : '';
  }, path);
  await expect.poll(() => cachedPage('/instructor.html')).toContain('id="joinPanel"');
  expect(await cachedPage('/index.html')).toContain('id="zollDevice"');
  await visit.close();

  // Make sure files come from the service worker, not the browser's HTTP cache
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#zollDevice')).toBeVisible();
  await page.click('.quick-rhythm-panel [data-rhythm="svt"]');
  expect(await page.evaluate(() => state.rhythm)).toBe('svt');
  expect(await page.$eval('.main-header img', i => i.naturalWidth)).toBeGreaterThan(0);

  // The instructor window also opens offline, as itself rather than as the simulator
  const instructor = await context.newPage();
  await instructor.goto(`/instructor.html?session=${code}`);
  await expect(instructor.locator('#connectionStatus')).toHaveText('Connected to the simulator');
  await instructor.click('#rhythmButtons [data-rhythm="afib"]');
  await expect.poll(() => page.evaluate(() => state.rhythm)).toBe('afib');
});
