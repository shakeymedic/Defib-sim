const { test } = require('@playwright/test');
const { openApp, message, sim, tick, setMode, setEnergy, chargeAndShock, expect } = require('./helpers');

async function startScenario(page, mode, id) {
  await page.click('#openScenariosBtn');
  await page.click(`[data-select-mode="${mode}"]`);
  await page.click(`[data-scenario="${id}"]`);
  await tick(page, 3100);
  expect(await sim(page, 'state.scenarioActive')).toBe(true);
}

test.describe('Scenarios', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('unstable VT scenario: cardioversion, summary and certificate', async ({ page }) => {
    await startScenario(page, 'education', 'unstable-vt');
    await expect(page.locator('#instructorPanel')).toBeVisible();
    await expect(page.locator('#hrDisplay')).toHaveText('180');
    await page.click('#checkPulseBtn');
    await tick(page, 1600);
    await expect(message(page)).toContainText('PULSE PRESENT');

    await setMode(page, 'defib');
    await page.click('#syncBtn');
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('nsr');
    await expect(page.locator('#hrDisplay')).toHaveText('76');

    await page.click('#endScenarioBtn');
    await expect(page.locator('#summaryScreen')).toBeVisible();
    await expect(page.locator('#summaryOutcome')).toContainText('RHYTHM CONVERTED');
    await expect(page.locator('#summaryFeedback')).toContainText('Sync mode activated correctly');

    await page.click('#printCertBtn');
    await expect(page.locator('#certificateScreen')).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.main-header')).toBeHidden();
    await expect(page.locator('#certificateContent')).toBeVisible();
  });

  test('assessment mode hides instructor controls; untreated VF is not converted', async ({ page }) => {
    await startScenario(page, 'assessment', 'vf-arrest');
    await expect(page.locator('#instructorPanel')).toBeHidden();
    await expect(page.locator('#cprPanel')).toHaveClass(/active/);
    await page.click('#endScenarioBtn');
    await expect(page.locator('#summaryOutcome')).toContainText('not converted');
    await page.click('#returnToMenuBtn');
    expect(await sim(page, 'state.sessionType')).toBe('free');
    expect(await sim(page, 'state.deviceMode')).toBe('off');
  });

  test('complete heart block scenario: pacing capture', async ({ page }) => {
    await startScenario(page, 'education', 'complete-hb');
    await setMode(page, 'pacer');
    for (let i = 0; i < 24 && !(await sim(page, 'state.mechanicalCapture')); i++) {
      await page.click('[data-pacer-param="output"][data-pacer-dir="5"]');
    }
    expect(await sim(page, 'state.isCaptured')).toBe(true);
    await page.click('#endScenarioBtn');
    await expect(page.locator('#summaryOutcome')).toContainText('PACING SUCCESSFUL');
  });

  test('custom scenario runs through its triggers', async ({ page }) => {
    await page.click('#openScenarioCreatorBtn');
    for (let i = 0; i < 4; i++) await page.click('#addStepBtn');
    await expect(page.locator('.scenario-step-card h5')).toHaveText(['Step 1', 'Step 2', 'Step 3', 'Step 4']);
    const steps = [['vfib', 'shock'], ['pea', 'manual'], ['chb', 'pacing'], ['afib', 'timer_30']];
    for (const [i, [rhythm, trigger]] of steps.entries()) {
      await page.selectOption(`#step-${i} .step-rhythm`, rhythm);
      await page.selectOption(`#step-${i} .step-trigger`, trigger);
    }
    await page.click('#startCustomScenarioBtn');
    expect(await sim(page, 'state.rhythm')).toBe('vfib');

    await setMode(page, 'defib');
    await setEnergy(page, 150);
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('pea');
    await tick(page, 2000);
    expect(await sim(page, 'state.rhythm')).toBe('pea');

    await page.click('#analyseBtn');
    await tick(page, 2600);
    expect(await sim(page, 'state.rhythm')).toBe('chb');
    await expect(message(page)).toHaveText('NO SHOCK ADVISED');

    await setMode(page, 'pacer');
    for (let i = 0; i < 24 && (await sim(page, 'state.rhythm')) !== 'afib'; i++) {
      await page.click('[data-pacer-param="output"][data-pacer-dir="5"]');
    }
    expect(await sim(page, 'state.rhythm')).toBe('afib');
    await tick(page, 31000);
    expect(await sim(page, 'state.customScenarioActive')).toBe(false);

    await page.click('#resetScenarioBtn');
    expect(await sim(page, 'state.rhythm')).toBe('vfib');
    await page.click('#endScenarioBtn');
    expect(await sim(page, 'state.sessionType')).toBe('free');
  });

  test('canvas keeps its size after resizing while a menu is open', async ({ page }) => {
    await page.click('#openScenarioCreatorBtn');
    await page.setViewportSize({ width: 900, height: 900 });
    await page.click('#cancelCustomScenarioBtn');
    await tick(page, 100);
    expect(await page.$eval('#ecgCanvas', c => c.width)).toBeGreaterThan(100);
  });
});
