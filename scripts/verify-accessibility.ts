import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page, type Locator } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { testDatabase } from '../apps/api/test/helpers/database.js';

const CHROMIUM_PATH = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/akuma/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

async function tabTo(page: Page, target: Locator, maxTabs = 50) {
  await target.waitFor();
  for (let i = 0; i < maxTabs; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail(`Element ${target} was not reachable via keyboard Tab traversal`);
}

async function activate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

async function typeInto(page: Page, target: Locator, value: string) {
  await tabTo(page, target);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(value);
}

async function runAxe(page: Page, viewName: string) {
  console.info(`Running axe-core accessibility analysis on: ${viewName}...`);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  if (results.violations.length > 0) {
    console.error(`Accessibility violations found in ${viewName}:`);
    for (const v of results.violations) {
      console.error(`- [${v.impact?.toUpperCase()}] ${v.id}: ${v.help} (${v.helpUrl})`);
      for (const node of v.nodes) {
        console.error(`    target: ${node.target.join(' ')}`);
        console.error(`    html: ${node.html}`);
      }
    }
    throw new Error(`Accessibility violations detected in ${viewName}: ${results.violations.length} violations`);
  }
  console.info(`  ✓ ${viewName}: 0 axe violations (${results.passes.length} checks passed)`);
  return results;
}

async function main() {
  console.info('=== Starting TeamForge Automated Accessibility Verification ===\n');

  const db = await testDatabase();
  const server = createServer();
  let browser: Browser | undefined;

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    console.info(`Test server listening at ${origin}`);

    const config = readConfig({
      DATABASE_URL: db.connectionString,
      JWT_SECRET: randomBytes(32).toString('hex'),
      APP_ORIGIN: origin,
      NODE_ENV: 'test',
    });

    const app = createApp({
      checkDatabase: async () => {},
      identity: { pool: db.pool, config },
      webDirectory: resolve('apps/web/dist'),
    });
    server.on('request', app);

    // Seed a hackathon
    await db.pool.query(
      "INSERT INTO hackathons (name, min_team_size, max_team_size) VALUES ('A11y Hackathon 2026', 2, 4) RETURNING id",
    );

    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);

    // 1. Login View
    await page.goto(`${origin}/login`);
    await page.getByRole('heading', { level: 1, name: 'Welcome back.' }).waitFor();
    await runAxe(page, 'Login Page');

    // Verify skip to content on login
    await page.keyboard.press('Tab');
    const skipLink = page.locator(':focus');
    assert.equal(await skipLink.textContent(), 'Skip to content');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'main');

    // 2. Signup View
    await page.goto(`${origin}/signup`);
    await page.getByRole('heading', { level: 1, name: 'Start with your spark.' }).waitFor();
    await runAxe(page, 'Signup Page');

    // Complete signup for a test user
    const userEmail = `a11y_user_${randomUUID().slice(0, 8)}@teamforge.test`;
    await typeInto(page, page.getByLabel('Display name', { exact: true }), 'Alex Rivera');
    await typeInto(page, page.getByLabel('Email address'), userEmail);
    await typeInto(page, page.getByLabel('Password', { exact: true }), 'browser-team-test-password');
    await activate(page, page.getByRole('button', { name: 'Create account', exact: true }));

    // 3. Onboarding View
    await page.getByRole('heading', { name: 'Tell us what you bring.' }).waitFor();
    await runAxe(page, 'Onboarding View');

    // Select skill and register
    await activate(page, page.getByRole('button', { name: 'Register for hackathon' }));
    await page.getByRole('status').filter({ hasText: 'You’re registered' }).waitFor();

    // 4. Team Creation via My Team View
    await page.goto(`${origin}/me`);
    await page.getByRole('heading', { name: 'Create a team', exact: true }).waitFor();
    await runAxe(page, 'My Team (Create Form & Join Controls)');

    // Create a team with open seats
    await typeInto(page, page.getByLabel('Team name'), 'Accessibility Champions');
    await typeInto(page, page.getByLabel('What will you build?'), 'An accessible team building app');
    await activate(page, page.getByRole('button', { name: 'Create team', exact: true }));
    await page.getByRole('heading', { name: 'Accessibility Champions' }).waitFor();

    // 5. Team Detail View (as Leader) & Management Controls
    await runAxe(page, 'Team Detail View (Leader Mode)');

    // 6. Dialog: Leave / Delete Team Confirmation Dialog
    const leaveBtn = page.getByRole('button', { name: 'Leave team', exact: true });
    await leaveBtn.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await runAxe(page, 'Leave Team Confirmation Dialog');

    // Cancel out of dialog
    await page.getByRole('button', { name: 'Stay on team', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });

    // 7. Team Board View (Discovery Board)
    await page.goto(`${origin}/`);
    await page.getByRole('heading', { level: 1, name: 'Find your team.' }).waitFor();
    await runAxe(page, 'Team Discovery Board');

    console.info('\n✓ ALL 7 PAGE STATES AND DIALOGS PASSED AXE-CORE ACCESSIBILITY CHECKS WITH ZERO VIOLATIONS!');
  } finally {
    if (browser) await browser.close();
    server.close();
    await db?.dispose();
  }
}

main().catch((err) => {
  console.error('Accessibility test failed:', err);
  process.exit(1);
});
