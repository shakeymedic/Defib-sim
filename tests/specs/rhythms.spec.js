const { test } = require('@playwright/test');
const { openApp, expect } = require('./helpers');

// Rhythms with identifiable R-waves and the rate the monitor should show
const ORGANISED = {
  nsr: 75, sinus_brady: 45, sinus_tach: 120, brady: 38, svt: 190, vtach: 180,
  vt_pulseless: 180, idioventricular: 40, chb: 32, paced: 70, afib: 155, pea: 70
};

test.describe('Rhythm engine', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  test('every R-wave marker sits on a QRS peak', async ({ page }) => {
    const misses = await page.evaluate((keys) => {
      const out = [];
      keys.forEach(key => {
        const fn = window.rhythms[key];
        const hr = window.SIM_DATA.rhythmVitals[key].hr;
        const peaks = window.rhythmPeaks(key, 1000, 6000, hr);
        peaks.forEach(p => {
          const y = fn(p, hr, 0, { height: 300 });
          // Nothing within +/-6px may be higher on screen (smaller y) than the marked peak
          for (let d = -6; d <= 6; d += 0.5) {
            if (fn(p + d, hr, 0, { height: 300 }) < y - 0.5) { out.push(`${key}@${p.toFixed(1)}`); break; }
          }
        });
        if (!peaks.length) out.push(`${key}: no peaks`);
      });
      return out;
    }, Object.keys(ORGANISED));
    expect(misses).toEqual([]);
  });

  test('drawn rate matches the displayed heart rate', async ({ page }) => {
    const rates = await page.evaluate((keys) => {
      const speed = window.ecgSpeed;
      const res = {};
      keys.forEach(key => {
        const hr = window.SIM_DATA.rhythmVitals[key].hr;
        // Count R-waves over 2 minutes of trace
        res[key] = window.rhythmPeaks(key, 0, 120 * speed, hr).length / 2;
      });
      return res;
    }, Object.keys(ORGANISED));
    for (const [key, hr] of Object.entries(ORGANISED)) {
      expect(Math.abs(rates[key] - hr), key).toBeLessThanOrEqual(key === 'afib' ? 12 : 1);
    }
  });

  test('VF and asystole have no R-waves to synchronise to', async ({ page }) => {
    const counts = await page.evaluate(() => ['vfib', 'asystole'].map(k => window.rhythmPeaks(k, 0, 5000, 0).length));
    expect(counts).toEqual([0, 0]);
  });

  test('AF is irregular', async ({ page }) => {
    const intervals = await page.evaluate(() => {
      const p = window.rhythmPeaks('afib', 0, 3000, 155);
      return p.slice(1).map((x, i) => x - p[i]);
    });
    const min = Math.min(...intervals), max = Math.max(...intervals);
    expect(max / min).toBeGreaterThan(1.5);
  });

  test('broad complex rhythms are broad and narrow ones are narrow', async ({ page }) => {
    // QRS width measured at half the R-wave height, in milliseconds
    const widths = await page.evaluate(() => {
      const res = {};
      ['nsr', 'svt', 'idioventricular', 'chb', 'paced'].forEach(key => {
        const hr = window.SIM_DATA.rhythmVitals[key].hr;
        const fn = window.rhythms[key];
        const base = 150;
        const p = window.rhythmPeaks(key, 2000, 6000, hr)[0];
        const half = (base - fn(p, hr, 0, { height: 300 })) / 2;
        let l = p, r = p;
        while (base - fn(l, hr, 0, { height: 300 }) > half) l -= 0.25;
        while (base - fn(r, hr, 0, { height: 300 }) > half) r += 0.25;
        res[key] = (r - l) / window.ecgSpeed * 1000;
      });
      return res;
    });
    expect(widths.nsr).toBeLessThan(60);
    expect(widths.svt).toBeLessThan(60);
    for (const k of ['idioventricular', 'chb', 'paced']) expect(widths[k], k).toBeGreaterThan(80);
  });
});
