import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, Locator, Page } from 'playwright';
import { createApp } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { assertInvariants } from '../apps/api/src/db/invariants.js';
import { testDatabase } from '../apps/api/test/helpers/database.js';

const db = await testDatabase();
const server = createServer();
let browser: Browser | undefined;
const screenshots = resolve('.cache/phase3');
async function noOverflow(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
}
// Traverse the real tab order rather than moving focus directly to controls.
async function tabTo(page: Page, target: Locator) {
  await target.waitFor();
  for (let i = 0; i < 100; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail('Control is not reachable with Tab');
}
async function activate(page: Page, target: Locator) { await tabTo(page, target); await page.keyboard.press('Enter'); }
async function typeInto(page: Page, target: Locator, value: string) {
  await tabTo(page, target); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(value);
}
async function signup(page: Page, origin: string, name: string, email: string) {
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(15_000);
  await page.goto(`${origin}/signup`);
  await typeInto(page, page.getByLabel('Display name', { exact: true }), name);
  await typeInto(page, page.getByLabel('Email address'), email);
  await typeInto(page, page.getByLabel('Password', { exact: true }), 'browser-team-test-password');
  await activate(page, page.getByRole('button', { name: 'Create account', exact: true }));
  await page.getByRole('heading', { name: 'Tell us what you bring.' }).waitFor();
  await activate(page, page.getByRole('button', { name: 'Register for hackathon' }));
  await page.getByRole('status').filter({ hasText: 'You’re registered' }).waitFor();
  await activate(page, page.getByRole('link', { name: 'My team', exact: true }));
  await page.getByRole('heading', { name: 'Create a team', exact: true }).waitFor();
}
try {
  const { rows: [event] } = await db.pool.query<{ id: string }>("INSERT INTO hackathons (name,min_team_size,max_team_size) VALUES ('Team lifecycle — browser fixture',2,2) RETURNING id");
  const hid = event!.id;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: db.connectionString, JWT_SECRET: randomBytes(32).toString('hex') });
  server.on('request', createApp({ checkDatabase: async () => { await db.pool.query('SELECT 1'); }, identity: { pool: db.pool, config }, webDirectory: resolve('apps/web/dist') }));
  browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  await mkdir(screenshots, { recursive: true });
  for (const width of [375, 1280]) {
    const leaderContext = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const memberContext = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const leader = await leaderContext.newPage(); const member = await memberContext.newPage();
      for (const page of [leader, member]) page.on('response', (response) => {
        if (response.status() >= 400) console.info(JSON.stringify({ width, status: response.status(), path: new URL(response.url()).pathname }));
      });
      const errors: string[] = [];
      leader.on('pageerror', (error) => errors.push(error.message)); member.on('pageerror', (error) => errors.push(error.message));
      await signup(leader, origin, `Leader ${width}`, `leader-${width}@example.test`);
      await signup(member, origin, `Member ${width}`, `member-${width}@example.test`);
      await noOverflow(leader); await leader.screenshot({ path: `${screenshots}/create-${width}.png`, fullPage: true });
      await activate(leader, leader.getByRole('button', { name: 'Create team', exact: true }));
      await leader.locator('#team-name[aria-invalid="true"]:focus').waitFor();
      const keys: string[] = [];
      await leader.route('**/api/hackathons/*/teams', async (route) => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const key = route.request().headers()['idempotency-key']; assert.match(key ?? '', /^[0-9a-f-]{36}$/); keys.push(key!);
        if (keys.length === 1) {
          // Commit the REAL request, then lose its response. The browser must retry
          // with the same key, and the API must replay rather than create twice.
          const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('connectionreset');
        } else await route.continue();
      });
      const replay = leader.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/hackathons/${hid}/teams`) && response.headers()['idempotent-replay'] === 'true');
      await leader.keyboard.type(`Builders ${width}`);
      await leader.keyboard.press('Tab'); await leader.keyboard.type('A small team with a shared idea.');
      await tabTo(leader, leader.getByLabel('Open to new teammates')); await leader.keyboard.press('Space');
      await activate(leader, leader.getByRole('button', { name: 'Create team', exact: true }));
      await leader.getByRole('button', { name: 'Creating team…', exact: true }).waitFor();
      assert.equal(await leader.getByRole('button', { name: 'Creating team…', exact: true }).isDisabled(), true);
      await leader.getByRole('heading', { name: `Builders ${width}`, exact: true }).waitFor();
      await replay;
      assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
      const teamId = new URL(leader.url()).pathname.split('/').at(-1)!;
      assert.equal((await db.pool.query("SELECT * FROM audit_log WHERE team_id=$1 AND action='team.created'", [teamId])).rowCount, 1);
      assert.equal((await db.pool.query('SELECT * FROM team_members WHERE team_id=$1', [teamId])).rowCount, 1);
      const code = await leader.getByLabel('Invite code', { exact: true }).inputValue();
      await activate(leader, leader.getByRole('button', { name: 'Copy invite code' }));
      await leader.getByRole('status').filter({ hasText: 'Invite code copied.' }).waitFor();
      assert.equal(await leader.evaluate(() => navigator.clipboard.readText()), code);
      await typeInto(member, member.getByLabel('Invite code', { exact: true }), 'ZZZZZZZZZZ');
      await activate(member, member.getByRole('button', { name: 'Join team', exact: true }));
      await member.getByRole('alert').filter({ hasText: 'This invite code is invalid or expired.' }).waitFor();
      await typeInto(member, member.getByLabel('Invite code', { exact: true }), code.toLowerCase());
      await activate(member, member.getByRole('button', { name: 'Join team', exact: true }));
      await member.getByRole('heading', { name: `Builders ${width}`, exact: true }).waitFor();
      assert.equal(await member.getByRole('button', { name: 'Copy invite code' }).count(), 0);
      await member.getByText('2 of 2 members', { exact: false }).waitFor();
      await activate(leader, leader.getByRole('button', { name: 'Refresh team', exact: true }));
      await leader.getByText('2 of 2 members', { exact: false }).waitFor();
      await noOverflow(leader); await noOverflow(member);
      await leader.screenshot({ path: `${screenshots}/leader-${width}.png`, fullPage: true });
      await member.screenshot({ path: `${screenshots}/member-${width}.png`, fullPage: true });
      // Native confirmation dialog supports Escape and restores keyboard focus.
      await activate(leader, leader.getByRole('button', { name: 'Leave team', exact: true }));
      await leader.getByRole('dialog').waitFor();
      await leader.keyboard.press('Escape');
      assert.equal(await leader.locator(':focus').textContent(), 'Leave team');
      await leader.keyboard.press('Enter');
      await activate(leader, leader.getByRole('button', { name: 'Confirm leave', exact: true }));
      await leader.getByRole('status').filter({ hasText: 'You left the team.' }).waitFor();
      await leader.getByRole('heading', { name: 'Create a team', exact: true }).waitFor();
      await activate(member, member.getByRole('button', { name: 'Refresh team', exact: true }));
      await member.getByRole('button', { name: 'Copy invite code' }).waitFor();
      await member.getByText('1 of 2 members', { exact: false }).waitFor();
      assert.equal((await db.pool.query('SELECT u.display_name FROM teams t JOIN users u ON u.id=t.leader_id WHERE t.id=$1', [teamId])).rows[0]?.display_name, `Member ${width}`);
      await activate(member, member.getByRole('button', { name: 'Leave team', exact: true }));
      await member.getByText('You are the last member. Leaving will delete this team.').waitFor();
      await noOverflow(member);
      await member.screenshot({ path: `${screenshots}/leave-${width}.png`, fullPage: true });
      await activate(member, member.getByRole('button', { name: 'Confirm leave', exact: true }));
      await member.getByRole('status').filter({ hasText: 'You left the team.' }).waitFor();
      await member.getByRole('heading', { name: 'Create a team', exact: true }).waitFor();
      assert.equal((await db.pool.query('SELECT * FROM teams WHERE id=$1', [teamId])).rowCount, 0);
      assert.equal((await db.pool.query("SELECT * FROM audit_log WHERE team_id=$1 AND action='team.deleted'", [teamId])).rowCount, 1);
      await assertInvariants(db.pool, hid); assert.deepEqual(errors, []);
      console.info(`Team browser flow passed at ${width}px: keyboard signup/register/create/copy/join, lost-response replay, private fields, leave dialog, promotion, deletion and invariants.`);
    } finally { await leaderContext.close(); await memberContext.close(); }
  }
} finally {
  await browser?.close();
  if (server.listening) await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  });
  await db.dispose();
}
