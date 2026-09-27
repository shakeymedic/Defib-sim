const { test } = require('@playwright/test');
const { openApp, message, sim, tick, setRhythm, setMode, setEnergy, charge, chargeAndShock, expect } = require('./helpers');

test.describe('Defibrillator controls', () => {
  let errors;
  test.beforeEach(async ({ page }) => { errors = await openApp(page); });
  test.afterEach(() => expect(errors).toEqual([]));

  test('analysis result stays on screen', async ({ page }) => {
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await page.click('#analyseBtn');
    await tick(page, 2600);
    await expect(message(page)).toHaveText('SHOCKABLE RHYTHM DETECTED');

    await setRhythm(page, 'asystole');
    await page.click('#analyseBtn');
    await tick(page, 2600);
    await expect(message(page)).toHaveText('NO SHOCK ADVISED');
  });

  test('changing energy while charged cancels the charge', async ({ page }) => {
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await charge(page);
    await page.click('.energy-arrow[data-energy-dir="1"]');
    expect(await sim(page, 'state.machineState')).toBe('IDLE');
    await expect(page.locator('#shockBtn')).toBeDisabled();

    // Keyboard shortcut cannot bypass the disabled button
    await page.keyboard.press('s');
    await tick(page, 3000);
    expect(await sim(page, 'state.shockCount')).toBe(0);

    // And the device can be charged again
    await charge(page);
  });

  test('changing mode dumps the charge', async ({ page }) => {
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await charge(page);
    await setMode(page, 'off');
    expect(await sim(page, 'state.machineState')).toBe('IDLE');
    await expect(page.locator('#shockBtn')).toBeDisabled();

    await setMode(page, 'defib');
    await page.click('#chargeBtn');
    await tick(page, 500);
    await setMode(page, 'monitor');
    await tick(page, 3000);
    expect(await sim(page, 'state.machineState')).toBe('IDLE');
  });

  test('VF needs at least 150J and converts on the third adequate shock', async ({ page }) => {
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await setEnergy(page, 120);
    await chargeAndShock(page);
    await expect(message(page)).toContainText('ENERGY TOO LOW');

    await setEnergy(page, 150);
    await chargeAndShock(page);
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('vfib');
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('nsr');
    expect(await sim(page, 'state.roscAchieved')).toBe(true);
    expect(await sim(page, 'state.shockCount')).toBe(4);
  });

  test('instructor can make VF convert on the first shock', async ({ page }) => {
    await page.click('#minimiseBtn');
    await page.selectOption('#shockResponseSelect', '1');
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await setEnergy(page, 150);
    await chargeAndShock(page);
    expect(await sim(page, 'state.rhythm')).toBe('nsr');
  });

  test('synchronised shock is withheld in VF', async ({ page }) => {
    await setRhythm(page, 'vfib');
    await setMode(page, 'defib');
    await page.click('#syncBtn');
    await charge(page);
    await page.click('#shockBtn');
    await tick(page, 300);
    await expect(message(page)).toContainText('NO R-WAVE');
    expect(await sim(page, 'state.shockCount')).toBe(0);
    expect(await sim(page, 'state.machineState')).toBe('READY');
  });

  test('synchronised cardioversion converts VT with a pulse', async ({ page }) => {
    await setRhythm(page, 'vtach');
    await setMode(page, 'defib');
    await page.click('#syncBtn');
    await chargeAndShock(page);
    expect(await sim(page, 'state.shockCount')).toBe(1);
    expect(await sim(page, 'state.rhythm')).toBe('nsr');
  });

  test('confirming ROSC keeps the trace moving and shows the ETCO2 rise', async ({ page }) => {
    await setRhythm(page, 'vfib');
    await tick(page, 200);
    await page.click('#roscBtn');
    const x1 = await sim(page, 'window.waveformX');
    await tick(page, 1000);
    const x2 = await sim(page, 'window.waveformX');
    expect(x2 - x1).toBeGreaterThan(50);
    expect(parseFloat(await page.locator('#etco2Display').textContent())).toBeGreaterThan(5.5);
    await expect(page.locator('#cprPanel')).not.toHaveClass(/active/);
  });

  test('ETCO2 rises as soon as CPR starts', async ({ page }) => {
    await setRhythm(page, 'vfib');
    await tick(page, 200);
    await page.click('#cprToggleBtn');
    expect(parseFloat(await page.locator('#etco2Display').textContent())).toBeGreaterThanOrEqual(2.8);
  });

  test('keyboard shortcuts are ignored while a dialog is open', async ({ page }) => {
    await setMode(page, 'defib');
    await page.click('.hint-btn[data-guideline="shockable"]');
    await page.keyboard.press('c');
    await tick(page, 2500);
    expect(await sim(page, 'state.machineState')).toBe('IDLE');
    await expect(page.locator('#modalBody')).toContainText('adrenaline 1 mg');
  });
});
