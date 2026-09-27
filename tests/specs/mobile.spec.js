const { test } = require('@playwright/test');
const { openApp, sim, tick, setRhythm, setMode, expect } = require('./helpers');

// CSS transitions run on real time, not the fake clock, so poll until the panel settles
async function panelBox(page) {
  return page.locator('#cprPanel').boundingBox();
}

test.describe('Phone layout', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('no horizontal scrolling', async ({ page }) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('CPR panel is a bottom sheet that can be minimised and leaves after ROSC', async ({ page }) => {
    const vh = page.viewportSize().height;
    await setRhythm(page, 'vfib');
    await tick(page, 100);
    await expect.poll(async () => { const b = await panelBox(page); return b.y + b.height; }).toBeLessThanOrEqual(vh + 1);
    expect((await panelBox(page)).height).toBeLessThanOrEqual(vh * 0.76);

    await page.click('#cprMinimiseBtn');
    await expect.poll(async () => (await panelBox(page)).y).toBeGreaterThan(vh - 60);

    await page.click('#cprMinimiseBtn');
    await expect.poll(async () => { const b = await panelBox(page); return b.y + b.height; }).toBeLessThanOrEqual(vh + 1);
    await page.click('#roscBtn');
    await expect.poll(async () => (await panelBox(page)).y).toBeGreaterThanOrEqual(vh);
  });

  test('pacing and softkeys are usable', async ({ page }) => {
    await expect(page.locator('#checkPulseBtn')).toBeVisible();
    await setMode(page, 'pacer');
    await expect(page.locator('#pacingCover')).toHaveClass(/open/);
    await page.click('[data-pacer-param="output"][data-pacer-dir="5"]');
    expect(await sim(page, 'state.pacerOutput')).toBe(5);
  });
});
