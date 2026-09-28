const { test } = require('@playwright/test');
const { openApp, sim, expect } = require('./helpers');

// These tests use real time in both windows: the link relies on heartbeats and
// snapshots passing between two pages, which a fake clock in one page would stall

async function popOut(page, context) {
  const [instructor] = await Promise.all([
    context.waitForEvent('page'),
    page.click('#popoutInstructorBtn')
  ]);
  const errors = [];
  instructor.on('pageerror', e => errors.push(e.message));
  instructor.dialogs = [];
  instructor.on('dialog', d => { instructor.dialogs.push(d.message()); d.accept().catch(() => {}); });
  await instructor.waitForLoadState();
  await expect(instructor.locator('#connectionStatus')).toHaveText('Connected to the simulator');
  instructor.errors = errors;
  return instructor;
}

test.describe('Separate instructor window', () => {
  let errors;
  let mainDialogs;
  test.beforeEach(async ({ page }) => {
    errors = await openApp(page, { clock: false });
    mainDialogs = [];
    page.on('dialog', d => mainDialogs.push(d.message()));
  });
  test.afterEach(() => expect(errors).toEqual([]));

  test('pops out, connects and turns the simulator into the learner view', async ({ page, context }) => {
    const code = await page.locator('#sessionCodeDisplay').textContent();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);

    const instructor = await popOut(page, context);
    expect(new URL(instructor.url()).searchParams.get('session')).toBe(code);
    await expect(instructor.locator('#codeDisplay')).toHaveText(code);
    await expect(instructor.locator('#rhythmButtons [data-rhythm="vfib"]')).toBeEnabled();

    await expect(page.locator('#remoteBanner')).toBeVisible();
    await expect(page.locator('.quick-rhythm-panel')).toBeHidden();
    await expect(page.locator('.header-actions')).toBeHidden();
    await expect(page.locator('#instructorPanel')).toBeHidden();
    // The learner still has the whole device and the guideline hints
    await expect(page.locator('#zollDevice')).toBeVisible();
    await expect(page.locator('.guideline-hints-panel')).toBeVisible();

    // The instructor can bring the controls back to this screen and hide them again
    await page.click('#remoteControlsBtn');
    await expect(page.locator('.quick-rhythm-panel')).toBeVisible();
    await page.click('#remoteControlsBtn');
    await expect(page.locator('.quick-rhythm-panel')).toBeHidden();
    expect(instructor.errors).toEqual([]);
  });

  test('closing the instructor window gives the controls back', async ({ page, context }) => {
    const instructor = await popOut(page, context);
    await expect(page.locator('.quick-rhythm-panel')).toBeHidden();
    await instructor.close({ runBeforeUnload: true });
    await expect(page.locator('.quick-rhythm-panel')).toBeVisible();
    await expect(page.locator('#remoteBanner')).toBeHidden();
    await expect(page.locator('#instructorPanel')).toBeVisible();
  });

  test('rhythm, settings and artefacts are controlled from the instructor window', async ({ page, context }) => {
    const instructor = await popOut(page, context);

    await instructor.click('#rhythmButtons [data-rhythm="svt"]');
    await expect.poll(() => sim(page, 'state.rhythm')).toBe('svt');
    await expect(instructor.locator('#rhythmName')).toHaveText('SVT');
    await expect(instructor.locator('#rhythmButtons [data-rhythm="svt"]')).toHaveClass(/active/);
    // Selecting a rhythm switches a device that is off to monitor, as on the main screen
    await expect(instructor.locator('#deviceMode')).toHaveText('MONITOR');
    await expect(instructor.locator('#hrValue')).toHaveText(await page.locator('#hrDisplay').textContent());

    await instructor.selectOption('#shockResponseSelect', '2');
    await expect.poll(() => sim(page, 'state.shockResponse')).toBe('2');
    await expect(page.locator('#shockResponseSelect')).toHaveValue('2');
    await instructor.selectOption('#rOnTSelect', 'never');
    await expect.poll(() => sim(page, 'state.rOnT')).toBe('never');
    await instructor.selectOption('#refibSelect', 'once');
    await expect.poll(() => sim(page, 'state.refib')).toBe('once');

    await instructor.check('input[data-artefact="movement"]');
    await expect.poll(() => sim(page, 'state.noise.movement')).toBe(true);
    await expect(page.locator('#instructorPanel input[data-artefact="movement"]')).toBeChecked();
    await instructor.uncheck('input[data-artefact="movement"]');
    await expect.poll(() => sim(page, 'state.noise.movement')).toBe(false);

    // The learner's device actions show up in the instructor window
    await page.click('.mode-label[data-mode="defib"]');
    await expect(instructor.locator('#deviceMode')).toHaveText('DEFIB');
    await page.click('#syncBtn');
    await expect(instructor.locator('#syncState')).toHaveText('ON');
    await expect(instructor.locator('#messageMirror')).toHaveText(await page.locator('#messageBar').textContent());
    await expect(instructor.locator('#eventLog')).toContainText('Sync mode activated');
    expect(instructor.errors).toEqual([]);
  });

  test('cardiac arrest controls work from the instructor window', async ({ page, context }) => {
    const instructor = await popOut(page, context);
    await expect(instructor.locator('#cprBtn')).toBeDisabled();

    await instructor.click('#rhythmButtons [data-rhythm="vfib"]');
    await expect(instructor.locator('#cprBtn')).toBeEnabled();
    await expect(instructor.locator('#arrestIdle')).toBeHidden();

    await instructor.click('#cprBtn');
    await expect.poll(() => sim(page, 'state.cprActive')).toBe(true);
    await expect(instructor.locator('#cprBtn')).toHaveText('Stop CPR');

    await instructor.click('[data-drug="adrenaline"]');
    await expect.poll(() => sim(page, 'state.adrenalineTimes.length')).toBe(1);
    await expect(instructor.locator('#adrenalineStatus')).toContainText('1 dose');

    await instructor.click('[data-drug="amiodarone"]');
    await expect.poll(() => sim(page, 'state.amiodaroneDoses')).toBe(1);
    await expect(instructor.locator('#amiodaroneBtn')).toHaveText('Amiodarone 150mg');

    await instructor.click('#causeButtons [data-cause="Hypoxia"]');
    await expect(page.locator('.cause-btn[data-cause="Hypoxia"]')).toHaveClass(/checked/);
    await expect(instructor.locator('#causeButtons [data-cause="Hypoxia"]')).toHaveClass(/checked/);

    await instructor.click('#nextCycleBtn');
    await expect(instructor.locator('#eventLog')).toContainText('CYCLE RESET');

    await instructor.click('#roscBtn');
    await expect.poll(() => sim(page, 'state.roscAchieved')).toBe(true);
    await expect(instructor.locator('#cprBtn')).toBeDisabled();
    expect(instructor.errors).toEqual([]);
  });

  test('drug prompts reach the instructor window even in assessment mode', async ({ page, context }) => {
    const instructor = await popOut(page, context);
    await instructor.selectOption('#scenarioSelect', 'vf-arrest');
    await instructor.selectOption('#scenarioModeSelect', 'assessment');
    await instructor.click('#startScenarioBtn');
    await expect.poll(() => sim(page, 'state.selectedScenario')).toBe('vf-arrest');
    await instructor.click('#rhythmButtons [data-rhythm="asystole"]');
    await expect(instructor.locator('#drugPrompt')).toContainText('Adrenaline 1mg due now');
    // ...but not to the learner
    await expect(page.locator('#drugPrompt')).toBeHidden();
    expect(await page.locator('#drugPrompt').textContent()).toBe('');
  });

  test('scenarios are started, reset and ended from the instructor window', async ({ page, context }) => {
    const instructor = await popOut(page, context);
    await instructor.selectOption('#scenarioSelect', 'unstable-svt');
    await instructor.selectOption('#scenarioModeSelect', 'education');
    await instructor.click('#startScenarioBtn');
    await expect.poll(() => sim(page, 'state.selectedScenario')).toBe('unstable-svt');
    expect(await sim(page, 'state.selectedMode')).toBe('education');
    await expect(instructor.locator('#sessionName')).toHaveText(await page.evaluate(() => SIM_DATA.scenarios['unstable-svt'].name));
    // Still the learner view: education mode must not bring the panel back
    await expect(page.locator('#instructorPanel')).toBeHidden();
    await expect.poll(() => sim(page, 'state.scenarioActive'), { timeout: 6000 }).toBe(true);

    await instructor.click('#resetScenarioBtn');
    await expect.poll(() => sim(page, 'state.scenarioActive')).toBe(false);
    await expect.poll(() => sim(page, 'state.scenarioActive'), { timeout: 6000 }).toBe(true);

    await instructor.click('#endScenarioBtn');
    await expect(page.locator('#summaryScreen')).toBeVisible();
    await expect(instructor.locator('#sessionDetail')).toContainText('summary on the simulator screen');
    await expect(instructor.locator('#tryAgainBtn')).toBeEnabled();

    await instructor.click('#freePlayBtn');
    await expect(page.locator('#zollDevice')).toBeVisible();
    await expect.poll(() => sim(page, 'state.sessionType')).toBe('free');
    expect(await sim(page, 'state.deviceMode')).toBe('off');

    // Confirmations happen in the instructor window, never on the learner's screen
    expect(instructor.dialogs.length).toBe(3);
    expect(mainDialogs).toEqual([]);
    expect(instructor.errors).toEqual([]);
  });

  test('an instructor window can join by typing the session code', async ({ page, context }) => {
    const code = await page.locator('#sessionCodeDisplay').textContent();
    const instructor = await context.newPage();
    await instructor.goto('/instructor.html');
    await expect(instructor.locator('#joinPanel')).toBeVisible();
    await instructor.fill('#joinCode', 'nope');
    await instructor.click('#joinForm button');
    await expect(instructor.locator('#joinError')).toBeVisible();
    // Lower case and spaces are accepted
    await instructor.fill('#joinCode', `${code.slice(0, 3).toLowerCase()} ${code.slice(3)}`);
    await instructor.click('#joinForm button');
    await expect(instructor.locator('#connectionStatus')).toHaveText('Connected to the simulator');
    expect(new URL(instructor.url()).searchParams.get('session')).toBe(code);
    await expect(page.locator('.quick-rhythm-panel')).toBeHidden();
  });

  test('a different session code does not control this simulator', async ({ page, context }) => {
    const instructor = await context.newPage();
    await instructor.goto('/instructor.html?session=ABCDEF');
    await expect(instructor.locator('#connectionStatus')).toHaveText('Waiting for the simulator window...');
    await expect(instructor.locator('#rhythmButtons [data-rhythm="vfib"]')).toBeDisabled();
    await expect(page.locator('.quick-rhythm-panel')).toBeVisible();
  });

  test('unexpected commands are ignored', async ({ page, context }) => {
    const instructor = await popOut(page, context);
    const code = await page.locator('#sessionCodeDisplay').textContent();
    await instructor.evaluate(code => {
      const ch = new BroadcastChannel('defib-sim-' + code);
      const send = (name, args) => ch.postMessage({ v: 1, type: 'command', from: 'TESTER', role: 'instructor', name, args });
      send('setRhythm', { rhythm: '__proto__' });
      send('setRhythm', { rhythm: 'toString' });
      send('setting', { setting: 'shockResponse', value: 'banana' });
      send('setting', { setting: 'constructor', value: 'x' });
      send('artefact', { type: 'hasOwnProperty', on: true });
      send('startScenario', { scenario: 'vf-arrest', mode: 'sneaky' });
      send('drug', { drug: 'adrenaline' });   // No arrest running
      send('cpr');
      send('eval', { code: 'alert(1)' });
      send('setRhythm', null);
      ch.postMessage({ v: 2, type: 'command', from: 'TESTER', role: 'instructor', name: 'setRhythm', args: { rhythm: 'vfib' } });
      ch.postMessage('junk');
      ch.postMessage(null);
      ch.close();
    }, code);
    await instructor.click('#rhythmButtons [data-rhythm="afib"]');
    await expect.poll(() => sim(page, 'state.rhythm')).toBe('afib');
    expect(await sim(page, 'state.shockResponse')).toBe('auto');
    expect(await sim(page, 'state.selectedScenario')).toBe(null);
    expect(await sim(page, 'state.adrenalineTimes.length')).toBe(0);
    expect(await sim(page, 'state.cprActive')).toBe(false);
    expect(mainDialogs).toEqual([]);
  });
});
