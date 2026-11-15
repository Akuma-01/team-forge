import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { SignJWT } from 'jose';
import { createApp } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { issuer, audience } from '../apps/api/src/modules/auth/session.js';
import { assertInvariants } from '../apps/api/src/db/invariants.js';
import { testDatabase } from '../apps/api/test/helpers/database.js';
import { createParticipants, createTeam } from '../apps/api/test/helpers/factories.js';

const db = await testDatabase(); const server = createServer();
let browser: Browser | undefined; let closeRealtime = () => {};
const directory = resolve('.cache/phase7'); const completed: Array<{ width: number; checks: string[] }> = [];
async function keyboardClick(page: Page, locator: Locator) { await locator.focus(); await page.keyboard.press('Enter'); }
async function layout(page: Page) {
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow');
  assert.equal(await page.locator('a').first().textContent(), 'Skip to content');
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('a, button, input, select, summary')].flatMap((element) => {
    const target = element.matches('input[type=checkbox]') ? element.closest('label') ?? element : element;
    const rect = target.getBoundingClientRect();
    return rect.width && rect.height && (rect.width < 44 || rect.height < 44) ? [`${element.tagName}: ${element.textContent?.trim() || element.getAttribute('id')}`] : [];
  }));
  assert.deepEqual(smallTargets, [], 'Interactive targets are at least 44px');
}
async function confirm(page: Page, trigger: Locator, label: string) {
  await keyboardClick(page, trigger); await page.getByRole('dialog').waitFor();
  assert.equal(await page.locator(':focus').textContent(), 'Cancel');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  await keyboardClick(page, trigger); await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), label);
  await page.keyboard.press('Enter'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
try {
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/browser.json`, JSON.stringify({ passed: false, completed }, null, 2) + '\n');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: db.connectionString, JWT_SECRET: randomBytes(32).toString('hex') });
  const app = createApp({ checkDatabase: async () => { await db.pool.query('SELECT 1'); }, identity: { pool: db.pool, config }, webDirectory: resolve('apps/web/dist') });
  closeRealtime = () => app.locals.closeRealtime(); server.on('request', app);
  browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [375, 1280]) {
    const checks: string[] = []; const contexts: BrowserContext[] = []; const pages: Page[] = [];
    const { users, hackathonId: hid } = await createParticipants(db.pool, 17);
    await db.pool.query("UPDATE hackathons SET name='Build together weekend',min_team_size=2,max_team_size=2 WHERE id=$1", [hid]);
    const names = ['Asha', 'Mina', 'Leo'];
    for (let i = 0; i < users.length; i++) {
      await db.pool.query('UPDATE users SET display_name=$2,skills=$3,utc_offset_min=$4 WHERE id=$1',
        [users[i], names[i] ?? (i === 16 ? 'Nora' : `Builder ${i}`), i === 0 ? ['backend'] : ['design', 'product'], i === 2 ? -300 : 330]);
    }
    for (let i = 3; i < 16; i++) {
      const id = await createTeam(db.pool, hid, users[i]!, 2);
      await db.pool.query('UPDATE teams SET name=$2,description=$3,looking_for=$4 WHERE id=$1',
        [id, `Build Lab ${String(i - 2).padStart(2, '0')}`, 'Small teams building useful tools for their communities.', ['backend']]);
    }
    try {
      for (const id of users.slice(0, 3)) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] }); contexts.push(context);
        const iat = Math.floor(Date.now() / 1000) - 60;
        const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(id).setIssuer(issuer).setAudience(audience)
          .setIssuedAt(iat).setExpirationTime(iat + 604800).sign(new TextEncoder().encode(config.JWT_SECRET));
        await context.addCookies([{ name: 'sid', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.push(page);
      }
      const [leader, applicant, other] = pages as [Page, Page, Page];
      const errors: string[] = []; for (const page of pages) page.on('pageerror', (error) => errors.push(error.message));
      const initialName = `Signal Studio ${width}`; const renamed = `Signal Works ${width}`;
      await leader.goto(`${origin}/me?hackathon=${hid}`);
      await leader.getByLabel('Team name', { exact: true }).fill(initialName);
      await leader.getByLabel('What will you build?', { exact: true }).fill('A shared sketchpad for neighbourhood ideas.');
      const chosenSkills = leader.locator('#create-team fieldset input');
      for (let i = 0; i < 9; i++) await chosenSkills.nth(i).check();
      await keyboardClick(leader, leader.getByRole('button', { name: 'Create team', exact: true }));
      await leader.locator('fieldset[aria-invalid=true]:focus').waitFor();
      for (let i = 0; i < 9; i++) await chosenSkills.nth(i).uncheck();
      await leader.getByLabel('design', { exact: true }).check();
      await keyboardClick(leader, leader.getByRole('button', { name: 'Create team', exact: true }));
      await leader.getByRole('heading', { level: 1, name: initialName }).waitFor();
      const teamId = new URL(leader.url()).pathname.split('/').at(-1)!;
      const teamUrl = `${origin}/teams/${teamId}?hackathon=${hid}`;
      const originalCode = await leader.getByLabel('Invite code', { exact: true }).inputValue();
      await leader.getByText('Incomplete team', { exact: true }).waitFor();
      await leader.getByRole('status').filter({ hasText: /^Live$/ }).waitFor();
      await applicant.goto(`${origin}/?hackathon=${hid}`);
      await applicant.getByRole('button', { name: 'Load more teams' }).waitFor(); await layout(applicant);
      await applicant.screenshot({ path: `${directory}/board-${width}.png` });
      assert.equal(await applicant.locator('article').count(), 12);
      await keyboardClick(applicant, applicant.getByRole('button', { name: 'Load more teams' }));
      await applicant.waitForFunction(() => document.querySelectorAll('article').length === 14);
      assert.equal(await applicant.locator('article h3').evaluateAll((elements) => new Set(elements.map((e) => e.textContent)).size), 14);
      await applicant.getByLabel('Team name', { exact: true }).fill('nothing-matches-this');
      await keyboardClick(applicant, applicant.getByRole('button', { name: 'Find teams', exact: true }));
      await applicant.getByRole('heading', { name: 'No teams found yet.' }).waitFor();
      await applicant.getByRole('button', { name: 'Show all teams' }).click();
      await applicant.getByLabel('Looking for your skill').selectOption('design');
      await keyboardClick(applicant, applicant.getByRole('button', { name: 'Find teams', exact: true }));
      await applicant.waitForFunction(() => document.querySelectorAll('article').length === 1);
      await applicant.getByLabel('Team name', { exact: true }).fill('unsaved search');
      await applicant.goBack();
      await applicant.waitForFunction(() => document.querySelectorAll('article').length === 14);
      assert.equal(await applicant.getByLabel('Team name', { exact: true }).inputValue(), '');
      assert.equal(await applicant.getByLabel('Looking for your skill').inputValue(), '');
      await applicant.goForward();
      await applicant.waitForFunction(() => document.querySelectorAll('article').length === 1);
      assert.equal(await applicant.getByLabel('Looking for your skill').inputValue(), 'design');
      await keyboardClick(applicant, applicant.getByRole('heading', { name: initialName, exact: true }).getByRole('link'));
      await applicant.getByRole('heading', { level: 1, name: initialName }).waitFor();
      assert.equal(await applicant.locator(':focus').evaluate((element) => element.tagName), 'H1');
      assert.equal(await applicant.getByLabel('Invite code', { exact: true }).count(), 0);
      assert.equal(await applicant.getByRole('button', { name: 'Edit team', exact: true }).count(), 0);
      checks.push('board pagination, skill filtering, empty results, route focus and public permissions');

      const keys: string[] = [];
      await applicant.route(`**/api/hackathons/${hid}/teams/${teamId}/requests`, async (route) => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        keys.push(route.request().headers()['idempotency-key']!);
        if (keys.length === 1) { const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('connectionreset'); }
        else await route.continue();
      });
      await applicant.getByLabel('What would you like to bring?').fill('I can shape the design and talk to neighbours.');
      await keyboardClick(applicant, applicant.getByRole('button', { name: 'Apply to join' }));
      await applicant.getByRole('button', { name: 'Withdraw application', exact: true }).waitFor();
      // SSE can reveal the committed request before the dropped-response retry completes.
      await applicant.getByText('Application sent. You can track it in My team.', { exact: true }).waitFor();
      assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
      assert.equal((await db.pool.query("SELECT id FROM audit_log WHERE team_id=$1 AND action='request.created'", [teamId])).rowCount, 1);
      await applicant.unroute(`**/api/hackathons/${hid}/teams/${teamId}/requests`);
      await applicant.getByRole('link', { name: 'My team', exact: true }).click();
      await confirm(applicant, applicant.getByRole('button', { name: `Withdraw application to ${initialName}`, exact: true }), 'Withdraw application');
      await applicant.getByText(`Application to ${initialName} withdrawn.`, { exact: true }).waitFor();
      await leader.getByText('No pending applications.', { exact: false }).waitFor();
      checks.push('lost application response reuses its key; own requests, withdrawal and dialog focus');

      await applicant.goto(teamUrl); await applicant.getByRole('button', { name: 'Apply to join' }).click();
      await leader.getByRole('button', { name: 'Decline Mina' }).waitFor();
      await keyboardClick(leader, leader.getByRole('button', { name: 'Decline Mina' }));
      await applicant.getByRole('button', { name: 'Apply to join' }).waitFor();
      await applicant.getByRole('button', { name: 'Apply to join' }).click();
      await leader.getByRole('button', { name: 'Accept Mina' }).waitFor();
      const requestId = (await db.pool.query<{ id: string }>("SELECT id FROM join_requests WHERE team_id=$1 AND user_id=$2 AND status='pending'", [teamId, users[1]])).rows[0]!.id;
      const acceptKeys: string[] = []; let fillSeat = true;
      await leader.route(`**/api/hackathons/${hid}/requests/${requestId}/accept`, async (route) => {
        acceptKeys.push(route.request().headers()['idempotency-key']!);
        if (fillSeat) {
          fillSeat = false;
          const joined = await contexts[2]!.request.post(`${origin}/api/hackathons/${hid}/teams/join-by-code`, { headers: { Origin: origin }, data: { code: originalCode } });
          assert.equal(joined.status(), 200);
        }
        await route.continue();
      });
      await leader.getByRole('button', { name: 'Accept Mina' }).click();
      await leader.getByRole('alert').filter({ hasText: 'This team has no open seats.' }).waitFor();
      assert.equal((await db.pool.query('SELECT status FROM join_requests WHERE id=$1', [requestId])).rows[0]!.status, 'pending');
      await other.goto(teamUrl);
      await other.getByRole('button', { name: 'Leave team', exact: true }).click();
      await other.getByRole('button', { name: 'Confirm leave', exact: true }).click();
      await leader.getByText('1 of 2 members', { exact: false }).waitFor();
      await keyboardClick(leader, leader.getByRole('button', { name: 'Accept Mina' }));
      await applicant.getByRole('button', { name: 'Leave team', exact: true }).waitFor();
      assert.equal(acceptKeys.length, 2); assert.notEqual(acceptKeys[0], acceptKeys[1]);
      await leader.getByText('Ready to build', { exact: true }).waitFor(); await leader.getByText('Full', { exact: true }).waitFor();
      checks.push('decline, reapplication, full-team conflict preserves pending, fresh retry accepts and updates both browsers');

      await keyboardClick(leader, leader.getByRole('button', { name: 'Find teammates', exact: true }));
      const nora = leader.locator('li').filter({ has: leader.getByRole('heading', { name: 'Nora', exact: true }) });
      await nora.locator('summary').click(); await nora.getByText('Working-hours overlap', { exact: true }).waitFor();
      await keyboardClick(leader, leader.getByRole('button', { name: 'View activity', exact: true }));
      await leader.getByText('You accepted an application', { exact: true }).waitFor();
      await layout(leader); await leader.screenshot({ path: `${directory}/leader-${width}.png`, fullPage: true });
      await applicant.getByRole('button', { name: 'Find teammates', exact: true }).click();
      await applicant.getByRole('button', { name: 'View activity', exact: true }).click();
      await applicant.getByText('Asha accepted an application', { exact: true }).waitFor();
      await layout(applicant); checks.push('member suggestions with explanations and readable audit history');

      await keyboardClick(leader, leader.getByRole('button', { name: 'Edit team', exact: true }));
      assert.equal(await leader.locator(':focus').getAttribute('id'), 'edit-team-name');
      await leader.getByLabel('Team name', { exact: true }).fill(renamed);
      await leader.getByLabel('What will you build?', { exact: true }).fill('A working prototype built with our neighbours.');
      await leader.getByLabel('Open to new teammates').uncheck();
      await keyboardClick(leader, leader.getByRole('button', { name: 'Save team changes' }));
      await leader.getByRole('heading', { level: 1, name: renamed }).waitFor();
      await applicant.getByRole('heading', { level: 1, name: renamed }).waitFor();
      await leader.getByText('Closed to applications', { exact: true }).waitFor();
      await confirm(leader, leader.getByRole('button', { name: 'Rotate invite code' }), 'Generate new code');
      const rotated = await leader.getByLabel('Invite code', { exact: true }).inputValue(); assert.notEqual(rotated, originalCode);
      await keyboardClick(leader, leader.getByRole('button', { name: 'Load older activity' }));
      await leader.getByText('You created the team', { exact: true }).waitFor();
      assert.equal(await leader.locator(':focus').getAttribute('id'), 'audit-title');
      assert.ok(await leader.locator('#audit-body ol li').count() > 10);
      await db.pool.query("UPDATE teams SET invite_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1", [teamId]);
      await leader.getByRole('button', { name: 'Refresh team', exact: true }).click();
      await leader.getByText('This code has expired. Rotate it to invite someone new.').waitFor();
      await other.goto(`${origin}/me?hackathon=${hid}#join-team`);
      await other.getByLabel('Invite code', { exact: true }).fill(rotated); await other.getByRole('button', { name: 'Join team', exact: true }).click();
      await other.getByRole('alert').filter({ hasText: 'This invite code is invalid or expired.' }).waitFor();
      await confirm(leader, leader.getByRole('button', { name: 'Rotate invite code' }), 'Generate new code');
      const beforeRemoval = await leader.getByLabel('Invite code', { exact: true }).inputValue();
      await keyboardClick(applicant, applicant.getByRole('button', { name: 'Leave team', exact: true }));
      await applicant.getByRole('dialog').waitFor();
      await confirm(leader, leader.getByRole('button', { name: 'Remove Mina', exact: true }), 'Remove member');
      await applicant.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(await applicant.locator(':focus').evaluate((element) => element.tagName), 'H1');
      await applicant.getByRole('button', { name: 'Leave team', exact: true }).waitFor({ state: 'detached' });
      await applicant.getByRole('button', { name: 'Hide suggestions' }).waitFor({ state: 'detached' });
      await applicant.getByRole('button', { name: 'Hide activity' }).waitFor({ state: 'detached' });
      await applicant.getByText('This team is closed to applications.', { exact: false }).waitFor();
      const afterRemoval = await leader.getByLabel('Invite code', { exact: true }).inputValue(); assert.notEqual(afterRemoval, beforeRemoval);
      const protectedRead = await contexts[1]!.request.get(`${origin}/api/hackathons/${hid}/teams/${teamId}/audit`); assert.equal(protectedRead.status(), 404);
      await other.getByLabel('Invite code', { exact: true }).fill(beforeRemoval); await other.getByRole('button', { name: 'Join team', exact: true }).click();
      await other.getByRole('alert').filter({ hasText: 'This invite code is invalid or expired.' }).waitFor();
      checks.push('edit and close, audit pagination, manual rotation, expired code, removal rotation and revoked member UI/REST access');

      await applicant.goto(`${origin}/me?hackathon=${hid}#join-team`);
      await applicant.getByLabel('Invite code', { exact: true }).fill(afterRemoval);
      await keyboardClick(applicant, applicant.getByRole('button', { name: 'Join team', exact: true }));
      await applicant.getByRole('heading', { level: 1, name: renamed }).waitFor();
      await leader.getByRole('button', { name: 'Leave team', exact: true }).click(); await leader.getByRole('button', { name: 'Confirm leave', exact: true }).click();
      await applicant.getByLabel('Invite code', { exact: true }).waitFor();
      await applicant.getByRole('button', { name: 'Edit team', exact: true }).waitFor();
      await leader.goto(teamUrl); await leader.getByRole('heading', { level: 1, name: renamed }).waitFor();
      assert.equal(await leader.getByRole('button', { name: 'Rotate invite code' }).count(), 0);
      await applicant.getByRole('button', { name: 'Leave team', exact: true }).click(); await applicant.getByRole('button', { name: 'Confirm leave', exact: true }).click();
      await leader.getByRole('alert').filter({ hasText: 'Team not found.' }).waitFor();
      checks.push('private code joins a closed team, leadership transfer and deleted-team recovery');

      await other.route(`**/api/hackathons/${hid}/teams?*`, async (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BUSY', message: 'The database is busy. Please retry.', requestId: randomUUID() } }) }));
      await other.goto(`${origin}/?hackathon=${hid}`); await other.getByRole('alert').filter({ hasText: 'The database is busy.' }).waitFor();
      await other.unroute(`**/api/hackathons/${hid}/teams?*`); await other.getByRole('button', { name: 'Try again', exact: true }).click();
      await other.getByRole('button', { name: 'Load more teams' }).waitFor();
      await layout(other); await other.setViewportSize({ width: 320, height: 900 }); await layout(other);
      checks.push('explicit read failure and recovery, form-error focus, single h1, skip link, 44px targets, 320px layout and reduced-motion preference');
      assert.deepEqual(errors, []); await assertInvariants(db.pool, hid);
      completed.push({ width, checks }); console.log(JSON.stringify({ width, passed: true, checks }));
    } catch (error) {
      for (let i = 0; i < pages.length; i++) await pages[i]!.screenshot({ path: `${directory}/failure-${width}-${i}.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await Promise.all(contexts.map((context) => context.close())); }
  }
  await writeFile(`${directory}/browser.json`, JSON.stringify({ passed: true, completed }, null, 2) + '\n');
} finally {
  await browser?.close(); closeRealtime();
  await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
  await db.dispose();
}
