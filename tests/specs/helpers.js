// Shared helpers for the simulator specs
const { expect } = require('@playwright/test');

// Load the app with a fake clock so timers (charging, analysis, CPR cycle) can be fast-forwarded
async function openApp(page, { clock = true } = {}) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Prompts get page.promptValue (set by a test); confirms/alerts are accepted
  page.on('dialog', d => (d.type() === 'prompt' ? d.accept(page.promptValue || '') : d.accept()).catch(() => {}));
  await page.route('**/fonts.googleapis.com/**', r => r.abort());
  await page.route('**/fonts.gstatic.com/**', r => r.abort());
  if (clock) await page.clock.install();
  await page.goto('/index.html');
  await expect(page.locator('#zollDevice')).toBeVisible();
  return errors;
}

const message = page => page.locator('#messageBar');
const sim = (page, expr) => page.evaluate(expr);

async function tick(page, ms) {
  await page.clock.runFor(ms);
}

async function setRhythm(page, rhythm) {
  await page.evaluate(r => {
    const btn = document.querySelector(`.rhythm-btn[data-rhythm="${r}"]`);
    btn.click();
  }, rhythm);
}

async function setMode(page, mode) {
  await page.click(`.mode-label[data-mode="${mode}"]`);
}

async function setEnergy(page, joules) {
  for (let i = 0; i < 25; i++) {
    const current = await sim(page, 'state.energy');
    if (current === joules) return;
    await page.click(`.energy-arrow[data-energy-dir="${current < joules ? 1 : -1}"]`);
  }
  throw new Error(`Could not reach ${joules}J`);
}

async function charge(page) {
  await page.click('#chargeBtn');
  await tick(page, 2100);
  await expect.poll(() => sim(page, 'state.machineState')).toBe('READY');
}

// Charge, shock and let the outcome resolve
async function chargeAndShock(page) {
  await charge(page);
  await page.click('#shockBtn');
  await tick(page, 4500);
}

module.exports = { openApp, message, sim, tick, setRhythm, setMode, setEnergy, charge, chargeAndShock, expect };
