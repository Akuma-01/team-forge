import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { createApp } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { testDatabase } from '../apps/api/test/helpers/database.js';

// This harness uses the same guarded, disposable schema as the HTTP suites.
// Every page and mutation goes through the actual app, SQL and Argon2 paths.
const db = await testDatabase();
const server = createServer();
let browser: Browser | undefined;
const screenshotDirectory = resolve('.cache/phase2');
async function noOverflow(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
}
try {
  await db.pool.query("INSERT INTO hackathons (name, min_team_size, max_team_size) VALUES ('Builders weekend — browser fixture', 2, 4)");
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: db.connectionString, JWT_SECRET: randomBytes(32).toString('hex') });
  server.on('request', createApp({
    checkDatabase: async () => { await db.pool.query('SELECT 1'); },
    identity: { pool: db.pool, config }, webDirectory: resolve('apps/web/dist'),
  }));
  browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  await mkdir(screenshotDirectory, { recursive: true });
  for (const width of [375, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(15_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const email = `browser-${width}@example.test`;
      const password = 'browser-test-password-only';
      assert.equal((await page.goto(`${origin}/login`))!.status(), 200);
      await page.getByRole('heading', { level: 1, name: 'Welcome back.' }).waitFor();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
      await page.screenshot({ path: `${screenshotDirectory}/login-${width}.png`, fullPage: true });
      await noOverflow(page);
      await page.getByRole('link', { name: 'Create an account' }).click();
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.locator('#displayName[aria-invalid="true"]:focus').waitFor();
      await page.getByLabel('Display name', { exact: true }).fill('Browser builder');
      // Continue using only the keyboard, including onboarding and registration.
      await page.keyboard.press('Tab'); await page.keyboard.type(email);
      await page.keyboard.press('Tab'); await page.keyboard.type(password);
      await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Tell us what you bring.' }).waitFor();
      await page.getByLabel('Display name', { exact: true }).focus();
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(`Builder ${width}`);
      await page.keyboard.press('Tab'); await page.keyboard.press('Space'); // frontend
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Space'); // design
      for (let i = 0; i < 8; i++) await page.keyboard.press('Tab'); // Remaining seven skills, then UTC select.
      assert.equal(await page.locator(':focus').getAttribute('id'), 'offset');
      await page.keyboard.press('Home');
      for (let i = 0; i < 70; i++) await page.keyboard.press('ArrowDown'); // UTC +05:30
      assert.equal(await page.getByLabel('Time zone').inputValue(), '330');
      await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: 'Your profile is saved.' }).waitFor();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator(':focus').textContent(), 'Register for hackathon');
      await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: 'You’re registered' }).waitFor();
      const preference = page.getByLabel('Open to teammate suggestions');
      await preference.focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => {
        const input = document.querySelector<HTMLInputElement>('label input[type=checkbox]:disabled');
        return input === null;
      });
      assert.equal(await preference.isChecked(), false);
      await noOverflow(page);
      await page.screenshot({ path: `${screenshotDirectory}/onboarding-${width}.png`, fullPage: true });
      await page.keyboard.press('Tab');
      assert.match(await page.locator(':focus').textContent() ?? '', /Go to your workspace/);
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: `Hello, Builder ${width}.` }).waitFor();
      const sid = (await context.cookies()).find((cookie) => cookie.name === 'sid');
      assert.ok(sid?.httpOnly); assert.equal(sid.sameSite, 'Lax'); assert.equal(sid.secure, false);
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Welcome back.' }).waitFor();
      assert.equal((await context.cookies()).some((cookie) => cookie.name === 'sid'), false);
      await page.goto(`${origin}/profile`);
      await page.waitForURL(`${origin}/login`);
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: `Hello, Builder ${width}.` }).waitFor();
      await page.getByRole('link', { name: 'Your profile', exact: true }).click();
      assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), `Builder ${width}`);
      assert.equal(await page.getByLabel('frontend', { exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel('design', { exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel('Time zone').inputValue(), '330');
      await page.getByRole('status').filter({ hasText: 'You’re registered' }).waitFor();
      assert.equal(await page.getByLabel('Open to teammate suggestions').isChecked(), false);
      await noOverflow(page);
      // Expiry is observed on refetch, cancels user queries, and protects the route.
      await context.addCookies([{ name: 'sid', value: 'invalid-session', url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      await page.waitForURL(`${origin}/login`);
      assert.equal(await page.getByText(email, { exact: false }).count(), 0);
      await page.getByRole('link', { name: 'Create an account' }).click();
      await page.getByLabel('Display name', { exact: true }).fill('Another builder');
      await page.getByLabel('Email address').fill(`other-${width}@example.test`);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByRole('heading', { name: 'Tell us what you bring.' }).waitFor();
      assert.equal(await page.getByLabel('frontend', { exact: true }).isChecked(), false);
      await page.getByRole('button', { name: 'Register for hackathon' }).waitFor();
      assert.equal(await page.getByText(email, { exact: false }).count(), 0);
      assert.deepEqual(errors, []);
      console.info(`Auth browser flow passed at ${width}px: keyboard signup/onboarding, persisted profile, registration/preference, logout/login, expiry and account isolation.`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  if (server.listening) await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  });
  await db.dispose();
}
