# Browser tests

Automated Playwright tests for the simulator. They run on every pull request (see `.github/workflows/tests.yml`).

To run them locally:

```bash
cd tests
npm ci
npx playwright install chromium
npx playwright test
```

The tests serve the repository root with `serve.js` and use Playwright's fake clock, so charging, analysis and CPR timers are fast-forwarded rather than waited for.
