const { test } = require('@playwright/test');
const { openApp, sim, tick, setRhythm, setMode, expect } = require('./helpers');

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
    await tick(page, 700);
    let box = await page.locator('#cprPanel').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(vh + 1);
    expect(box.height).toBeLessThanOrEqual(vh * 0.76);

    await page.click('#cprMinimiseBtn');
    await tick(page, 700);
    box = await page.locator('#cprPanel').boundingBox();
    expect(box.y).toBeGreaterThan(vh - 60);

    await page.click('#cprMinimiseBtn');
    await tick(page, 700);
    await page.click('#roscBtn');
    await tick(page, 700);
    box = await page.locator('#cprPanel').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(vh);
  });

  test('pacing and softkeys are usable', async ({ page }) => {
    await expect(page.locator('#checkPulseBtn')).toBeVisible();
    await setMode(page, 'pacer');
    await tick(page, 500);
    await page.click('[data-pacer-param="output"][data-pacer-dir="5"]');
    expect(await sim(page, 'state.pacerOutput')).toBe(5);
  });
});
