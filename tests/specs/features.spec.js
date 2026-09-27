const { test } = require('@playwright/test');
const { openApp, message, sim, tick, setRhythm, setMode, setEnergy, charge, chargeAndShock, expect } = require('./helpers');

async function openInstructor(page) {
  if (await page.locator('#instructorPanel').evaluate(e => e.classList.contains('minimised'))) {
    await page.click('#minimiseBtn');
  }
}

async function raiseOutputUntil(page, predicate) {
  for (let i = 0; i < 28; i++) {
    if (await sim(page, predicate)) return;
    await page.click('[data-pacer-param="output"][data-pacer-dir="5"]');
  }
}

// Pacer spikes fired in the last `seconds` of trace
const recentSpikes = (page, seconds) => page.evaluate(sec => {
  const now = window.waveformX + document.getElementById('ecgCanvas').getBoundingClientRect().width;
  return window.ecgTrace.spikes(now - sec * window.ecgSpeed, now).length;
}, seconds);

test.describe('Monitor display', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('a rhythm change only affects the trace from the sweep onwards', async ({ page }) => {
    await setRhythm(page, 'nsr');
    await tick(page, 2000);
    const x = await sim(page, 'window.waveformX + 50');
    const before = await page.evaluate(x => window.ecgTrace.y(x, 300), x);
    await setRhythm(page, 'vfib');
    await tick(page, 50);
    const after = await page.evaluate(x => window.ecgTrace.y(x, 300), x);
    expect(after).toBeCloseTo(before, 5);
  });

  test('LEAD cycles PADS, I, II and III and changes the QRS size', async ({ page }) => {
    await setRhythm(page, 'nsr');
    await expect(page.locator('#leadInfo')).toContainText('LEAD: II');
    await page.click('#leadBtn');
    await expect(page.locator('#leadInfo')).toContainText('LEAD: III');
    await page.click('#leadBtn');
    await expect(page.locator('#leadInfo')).toContainText('LEAD: PADS');
    await page.click('#leadBtn');
    await expect(page.locator('#leadInfo')).toContainText('LEAD: I');
    await tick(page, 3000);
    expect(await page.evaluate(() => window.ecgTrace.current().lead)).toBe('I');
  });

  test('new rhythms: fine VF is shockable, flutter can be cardioverted', async ({ page }) => {
    await setRhythm(page, 'vfib_fine');
    await setMode(page, 'defib');
    await page.click('#analyseBtn');
    await tick(page, 2600);
    await expect(message(page)).toHaveText('SHOCKABLE RHYTHM DETECTED');

    await setRhythm(page, 'flutter');
    await expect(page.locator('#hrDisplay')).toHaveText('150');
    await page.click('#syncBtn');
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('nsr');
  });
});

test.describe('Pacing', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('demand pacing is inhibited by a faster intrinsic rhythm; async is not', async ({ page }) => {
    await setRhythm(page, 'sinus_brady'); // 45/min
    await setMode(page, 'pacer');
    await tick(page, 6000);
    expect(await recentSpikes(page, 4)).toBeGreaterThan(0);  // Set rate 60 > 45: pacer fires

    for (let i = 0; i < 4; i++) await page.click('[data-pacer-param="rate"][data-pacer-dir="-5"]'); // 40/min
    await tick(page, 6000);
    expect(await recentSpikes(page, 4)).toBe(0);              // Inhibited

    await page.click('#pacerModeBtn');
    await expect(page.locator('#pacerModeBtn')).toHaveText('MODE: ASYNC');
    await tick(page, 6000);
    expect(await recentSpikes(page, 4)).toBeGreaterThan(0);  // Fixed rate ignores intrinsic beats
  });

  test('electrical capture comes before mechanical capture', async ({ page }) => {
    await setRhythm(page, 'mobitz2');
    await setMode(page, 'pacer');
    await raiseOutputUntil(page, 'state.isCaptured');
    expect(await sim(page, 'state.isCaptured')).toBe(true);
    expect(await sim(page, 'state.mechanicalCapture')).toBe(false);
    await expect(page.locator('#hrDisplay')).toHaveText('60');
    await page.click('#checkPulseBtn');
    await tick(page, 1600);
    await expect(message(page)).toContainText('NO MECHANICAL CAPTURE');

    await raiseOutputUntil(page, 'state.mechanicalCapture');
    expect(await sim(page, 'state.mechanicalCapture')).toBe(true);
    await page.click('#checkPulseBtn');
    await tick(page, 1600);
    await expect(message(page)).toContainText('MATCHES PACED RATE');

    // Paced complexes carry the sync markers
    const peaks = await page.evaluate(() => {
      const now = window.waveformX + document.getElementById('ecgCanvas').getBoundingClientRect().width;
      return window.ecgTrace.peaks(now - 3 * window.ecgSpeed, now).length;
    });
    expect(peaks).toBeGreaterThanOrEqual(2);
  });
});

test.describe('Shock consequences', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('an unsynchronised shock with a pulse causes VF (unless switched off)', async ({ page }) => {
    await setRhythm(page, 'svt');
    await setMode(page, 'defib');
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('vfib');

    await openInstructor(page);
    await page.selectOption('#rOnTSelect', 'never');
    await setRhythm(page, 'svt');
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('svt');
    await expect(message(page)).toContainText('R-ON-T HAZARD');
  });

  test('VF can recur after ROSC when enabled', async ({ page }) => {
    await openInstructor(page);
    await page.selectOption('#shockResponseSelect', '1');
    await page.selectOption('#refibSelect', 'once');
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await setEnergy(page, 150);
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('nsr');
    await page.clock.fastForward(91000);
    await tick(page, 1000);
    expect(await sim(page, 'state.rhythm')).toBe('vfib');
  });
});

test.describe('Drug timing prompts', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('shockable arrest: adrenaline and amiodarone after the 3rd shock, amiodarone 150mg after the 5th', async ({ page }) => {
    await openInstructor(page);
    await page.selectOption('#shockResponseSelect', 'never');
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await setEnergy(page, 150);
    const prompt = page.locator('#drugPrompt');
    for (let i = 0; i < 2; i++) await chargeAndShock(page);
    await expect(prompt).toBeHidden();
    await chargeAndShock(page);
    await expect(prompt).toContainText('Adrenaline 1mg due');
    await expect(prompt).toContainText('Amiodarone 300mg due');

    await page.click('.cpr-action-btn[data-action="adrenaline"]');
    await page.click('.cpr-action-btn[data-action="amiodarone"]');
    await expect(prompt).toBeHidden();
    await expect(page.locator('#adrenalineStatus')).toContainText('1 dose');

    for (let i = 0; i < 2; i++) await chargeAndShock(page);
    await expect(prompt).toContainText('Amiodarone 150mg due');
    await page.click('.cpr-action-btn[data-action="amiodarone"]');
    await expect(page.locator('#amiodaroneStatus')).toContainText('300mg + 150mg');
  });

  test('non-shockable arrest: adrenaline now, then every 3-5 minutes', async ({ page }) => {
    await setRhythm(page, 'asystole');
    await tick(page, 1100);
    const prompt = page.locator('#drugPrompt');
    await expect(prompt).toContainText('Adrenaline 1mg due now');
    await page.click('.cpr-action-btn[data-action="adrenaline"]');
    await expect(prompt).toBeHidden();
    await page.clock.fastForward(181000);
    await tick(page, 1100);
    await expect(prompt).toContainText('3-5 min');
  });
});

test.describe('Scenario builder', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('steps can be removed, saved, loaded and imported', async ({ page }) => {
    await page.click('#openScenarioCreatorBtn');
    for (let i = 0; i < 3; i++) await page.click('#addStepBtn');
    await page.selectOption('#step-0 .step-rhythm', 'vfib');
    await page.selectOption('#step-1 .step-rhythm', 'pea');
    await page.selectOption('#step-2 .step-rhythm', 'asystole');
    await page.click('#step-1 .remove-step-btn');
    await expect(page.locator('.scenario-step-card h5')).toHaveText(['Step 1', 'Step 2']);
    await expect(page.locator('#step-1 .step-rhythm')).toHaveValue('asystole');

    page.promptValue = 'VF then asystole';
    await page.click('#saveScenarioBtn');
    await expect(page.locator('#savedScenarioSelect')).toHaveValue('VF then asystole');

    await page.click('#step-0 .remove-step-btn');
    await page.click('#step-0 .remove-step-btn');
    await expect(page.locator('.scenario-step-card')).toHaveCount(0);
    await page.click('#loadScenarioBtn');
    await expect(page.locator('.scenario-step-card')).toHaveCount(2);
    await expect(page.locator('#step-0 .step-rhythm')).toHaveValue('vfib');

    const file = { name: 'scenario.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ app: 'defib-sim', version: 1, steps: [
        { rhythm: 'chb', trigger: 'pacing' }, { rhythm: 'nsr', trigger: 'manual' }, { rhythm: 'svt', trigger: 'shock' }] })) };
    await page.setInputFiles('#importScenarioInput', file);
    await expect(page.locator('.scenario-step-card')).toHaveCount(3);
    await expect(page.locator('#step-2 .step-trigger')).toHaveValue('shock');
  });

  test('invalid files are rejected', async ({ page }) => {
    await page.click('#openScenarioCreatorBtn');
    await page.click('#addStepBtn');
    await page.setInputFiles('#importScenarioInput', { name: 'bad.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ steps: [{ rhythm: '<img src=x>', trigger: 'manual' }] })) });
    await expect(page.locator('.scenario-step-card')).toHaveCount(1);
  });
});

test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  test('dialog closes with Escape and returns focus', async ({ page }) => {
    const hint = page.locator('.hint-btn[data-guideline="brady"]');
    await hint.click();
    await expect(page.locator('#modalOverlay')).toBeVisible();
    await expect(page.locator('#closeModalBtn')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalOverlay')).toBeHidden();
    await expect(hint).toBeFocused();
  });

  test('mode selector is keyboard operable', async ({ page }) => {
    await page.locator('.mode-label[data-mode="defib"]').focus();
    await page.keyboard.press('Enter');
    expect(await sim(page, 'state.deviceMode')).toBe('defib');
  });
});
