// Regression tests for bugs found in the full code review
const { test } = require('@playwright/test');
const { openApp, message, sim, tick, setRhythm, setMode, setEnergy, chargeAndShock, expect } = require('./helpers');

const traceNow = page => page.evaluate(() =>
  window.waveformX + document.getElementById('ecgCanvas').getBoundingClientRect().width);

async function openInstructor(page) {
  if (await page.locator('#instructorPanel').evaluate(e => e.classList.contains('minimised'))) {
    await page.click('#minimiseBtn');
  }
}

test.describe('Review regressions', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('ECG keeps running when a custom scenario is started from the summary screen', async ({ page }) => {
    await page.click('#openScenariosBtn');
    await page.click('[data-select-mode="education"]');
    await page.click('[data-scenario="vf-arrest"]');
    await tick(page, 3100);
    await setMode(page, 'defib');
    await page.click('#endScenarioBtn');
    await expect(page.locator('#summaryScreen')).toBeVisible();

    await page.click('#openScenarioCreatorBtn');
    await page.click('#addStepBtn');
    await page.click('#startCustomScenarioBtn');
    const x1 = await sim(page, 'window.waveformX');
    await tick(page, 1000);
    expect(await sim(page, 'window.waveformX')).toBeGreaterThan(x1 + 50);
  });

  test('paced complexes continue across a lead change during capture', async ({ page }) => {
    await setRhythm(page, 'chb');
    await setMode(page, 'pacer');
    for (let i = 0; i < 16; i++) await page.click('[data-pacer-param="output"][data-pacer-dir="5"]');
    expect(await sim(page, 'state.mechanicalCapture')).toBe(true);
    await tick(page, 3000);

    // Change lead just after a pacer spike (the case that used to lose a complex)
    const now = await traceNow(page);
    const spike = await page.evaluate(n => window.ecgTrace.spikes(n, n + 2 * window.ecgSpeed)[0], now);
    await tick(page, Math.ceil((spike - now) / 125 * 1000) + 40);
    await page.click('#leadBtn');                 // II -> III
    await tick(page, 1500);

    const result = await page.evaluate(s => {
      const speed = window.ecgSpeed;
      // The paced complex after that spike is still drawn: its discordant T wave
      // (0.4s after the spike) sits below the baseline
      const tWaveDrop = window.ecgTrace.y(s + 0.4 * speed, 300) - 150;
      // ...and still carries a sync marker
      const marked = window.ecgTrace.peaks(s, s + 0.2 * speed).length;
      return { tWaveDrop, marked };
    }, spike);
    expect(result.tWaveDrop).toBeGreaterThan(5);
    expect(result.marked).toBe(1);
  });

  test('drug buttons return to their label after a quick double click', async ({ page }) => {
    await setRhythm(page, 'vfib');
    const btn = page.locator('.cpr-action-btn[data-action="adrenaline"]');
    await btn.click();
    await btn.click();
    await page.clock.runFor(1000);
    await expect(btn.locator('span')).toHaveText('ADRENALINE');
  });

  test('drug prompts follow the current rhythm', async ({ page }) => {
    await openInstructor(page);
    await page.selectOption('#shockResponseSelect', 'never');
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await setEnergy(page, 150);
    for (let i = 0; i < 3; i++) await chargeAndShock(page);
    await setRhythm(page, 'asystole');            // Now non-shockable
    await tick(page, 1100);
    const prompt = page.locator('#drugPrompt');
    await expect(prompt).toContainText('Adrenaline 1mg due now');
    await expect(prompt).not.toContainText('Amiodarone');
    await expect(prompt).not.toContainText('antero-posterior');
  });

  test('HR is counted from the ECG: shown in PEA and pVT, not in VF', async ({ page }) => {
    await setRhythm(page, 'pea');
    await expect(page.locator('#hrDisplay')).toHaveText('70');
    await expect(page.locator('#spo2Display')).toHaveText('---');
    await expect(page.locator('#bpDisplay')).toHaveText('---/---');
    await setRhythm(page, 'vt_pulseless');
    await expect(page.locator('#hrDisplay')).toHaveText('180');
    await setRhythm(page, 'vfib');
    await expect(page.locator('#hrDisplay')).toHaveText('---');
    await setRhythm(page, 'nsr');
    await expect(page.locator('#hrDisplay')).toHaveText('75');
    await expect(page.locator('#bpDisplay')).toHaveText('120/80');
  });

  test('scenario names that clash with built-in object names can be saved and loaded', async ({ page }) => {
    await page.click('#openScenarioCreatorBtn');
    await page.click('#addStepBtn');
    await page.selectOption('#step-0 .step-rhythm', 'svt');
    const dialogs = [];
    page.on('dialog', d => dialogs.push(d.type()));
    page.promptValue = 'toString';
    await page.click('#saveScenarioBtn');
    expect(dialogs).toEqual(['prompt']);          // No spurious "Replace?" confirm
    await expect(page.locator('#savedScenarioSelect')).toHaveValue('toString');
    await page.click('#step-0 .remove-step-btn');
    await page.click('#loadScenarioBtn');
    await expect(page.locator('#step-0 .step-rhythm')).toHaveValue('svt');
  });

  test('certificate does not claim success', async ({ page }) => {
    await page.click('#openScenariosBtn');
    await page.click('[data-select-mode="education"]');
    await page.click('[data-scenario="vf-arrest"]');
    await tick(page, 3100);
    await page.click('#endScenarioBtn');
    await page.click('#printCertBtn');
    await expect(page.locator('#certificateContent')).not.toContainText('successfully');
    await expect(page.locator('#certPerformance')).toContainText('Rhythm not converted');
  });
});
