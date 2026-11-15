import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { SignJWT } from 'jose';
import { createApp } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { issuer, audience } from '../apps/api/src/modules/auth/session.js';
import { assertInvariants } from '../apps/api/src/db/invariants.js';
import { testDatabase } from '../apps/api/test/helpers/database.js';
import { createParticipants } from '../apps/api/test/helpers/factories.js';

declare global {
  interface Window { liveSources: EventSource[]; dropStateEvents: boolean; droppedStateEvents: number }
}

const db = await testDatabase(); const server = createServer();
let browser: Browser | undefined; let closeRealtime = () => {};
const completed: string[] = [];
try {
  const { users, hackathonId: hid } = await createParticipants(db.pool, 3);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: db.connectionString, JWT_SECRET: randomBytes(32).toString('hex') });
  const app = createApp({ checkDatabase: async () => { await db.pool.query('SELECT 1'); }, identity: { pool: db.pool, config }, webDirectory: resolve('apps/web/dist') });
  closeRealtime = () => app.locals.closeRealtime(); server.on('request', app);
  browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  const contexts: BrowserContext[] = [];
  for (const id of users) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
    const iat = Math.floor(Date.now()/1000)-60;
    const token = await new SignJWT({}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(id).setIssuer(issuer).setAudience(audience)
      .setIssuedAt(iat).setExpirationTime(iat+604800).sign(new TextEncoder().encode(config.JWT_SECRET));
    await context.addCookies([{ name:'sid', value:token, url:origin, httpOnly:true, sameSite:'Lax' }]);
    // Drop only notification delivery to this test browser. REST and SSE server
    // connections remain real; the application has no test-only runtime switch.
    await context.addInitScript({ content: `
      window.liveSources=[]; window.dropStateEvents=false; window.droppedStateEvents=0;
      const NativeEventSource=window.EventSource;
      window.EventSource=class extends NativeEventSource {
        constructor(...args) { super(...args); window.liveSources.push(this); }
        addEventListener(type, listener, options) {
          if(type==='state.changed') return super.addEventListener(type, event => {
            if(window.dropStateEvents) { window.droppedStateEvents++; return; }
            if(typeof listener==='function') listener.call(this,event); else listener.handleEvent(event);
          }, options);
          return super.addEventListener(type,listener,options);
        }
      };
    ` });
  }
  const mutate = async (actor: number, path: string, body: unknown = {}, method = 'POST') => {
    const response = await contexts[actor]!.request.fetch(`${origin}/api/hackathons/${hid}${path}`, { method, headers:{Origin:origin}, data:body });
    assert.equal(response.status() >= 200 && response.status() < 300, true, `Mutation ${path}: ${response.status()}`);
    return response.json();
  };
  const {team} = await mutate(0,'/teams',{name:'Live builders'});
  const pages = await Promise.all(contexts.map(async (context) => {
    const page=await context.newPage(); page.setDefaultTimeout(15_000); return page;
  }));
  const errors: string[]=[]; for(const page of pages) page.on('pageerror',(error)=>errors.push(error.message));
  await Promise.all(pages.map(async (page) => {
    await page.goto(`${origin}/teams/${team.id}?hackathon=${hid}`);
    await page.getByRole('status').filter({hasText:/^Live$/}).waitFor();
    await page.getByText('1 of 4 members',{exact:false}).waitFor();
  }));
  let intercepted=false;
  await pages[0]!.route(`**/api/hackathons/${hid}/teams/${team.id}`,async(route)=>{
    if(intercepted) { await route.continue(); return; }
    intercepted=true;
    const oldResponse=await route.fetch();
    await pages[0]!.getByRole('status').filter({hasText:/^Live$/}).waitFor();
    await mutate(1,'/teams/join-by-code',{code:team.inviteCode});
    await route.fulfill({response:oldResponse});
  });
  await pages[0]!.reload();
  await Promise.all(pages.map((p)=>p.getByText('2 of 4 members',{exact:false}).waitFor()));
  await pages[0]!.unroute(`**/api/hackathons/${hid}/teams/${team.id}`);
  completed.push('join updates three clients, including a change during initial fetch');
  const {request}=await mutate(2,`/teams/${team.id}/requests`,{message:'Ready to build'});
  await mutate(0,`/requests/${request.id}/accept`);
  await Promise.all(pages.map((p)=>p.getByText('3 of 4 members',{exact:false}).waitFor())); completed.push('accept updates three clients');
  await mutate(2,`/teams/${team.id}/leave`);
  await Promise.all(pages.map((p)=>p.getByText('2 of 4 members',{exact:false}).waitFor())); completed.push('leave updates three clients');

  await pages[0]!.evaluate(() => { window.dropStateEvents=true; });
  await mutate(0,`/teams/${team.id}`,{description:'Recovered without an event'},'PATCH');
  await pages[0]!.waitForFunction(() => window.droppedStateEvents>0);
  await pages[1]!.getByText('Recovered without an event',{exact:true}).waitFor();
  await pages[0]!.getByText('Recovered without an event',{exact:true}).waitFor({timeout:35_000}); completed.push('visible periodic reconciliation recovers a lost event');
  await mutate(0,`/teams/${team.id}`,{description:'Recovered on focus'},'PATCH');
  await pages[0]!.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pages[0]!.getByText('Recovered on focus',{exact:true}).waitFor(); completed.push('focus reconciles even while notifications are dropped');
  await pages[0]!.evaluate(() => { window.dropStateEvents=false; });

  const refreshed = pages.map((p)=>p.waitForResponse((r)=>r.url()===`${origin}/api/hackathons/${hid}/teams/${team.id}` && r.status()===200));
  server.closeAllConnections(); await Promise.all(refreshed); completed.push('reconnect refetches authorized views');
  await mutate(0,`/teams/${team.id}/leave`);
  await pages[0]!.getByLabel('Invite code',{exact:true}).waitFor({state:'detached'});
  await pages[1]!.getByLabel('Invite code',{exact:true}).waitFor(); completed.push('leadership transfer removes old private fields');
  const invite=await pages[1]!.getByLabel('Invite code',{exact:true}).inputValue();
  await mutate(2,'/teams/join-by-code',{code:invite});
  await pages[2]!.getByRole('button',{name:'Leave team',exact:true}).waitFor();
  await mutate(1,`/teams/${team.id}/members/${users[2]}`,{},'DELETE');
  await pages[2]!.getByRole('button',{name:'Leave team',exact:true}).waitFor({state:'detached'});
  const forbidden=await contexts[2]!.request.get(`${origin}/api/hackathons/${hid}/teams/${team.id}/suggestions`); assert.equal(forbidden.status(),404);
  completed.push('removed member reconciles and loses protected REST access');
  await pages[1]!.getByRole('button',{name:'Sign out',exact:true}).click();
  await pages[1]!.waitForURL('**/login');
  assert.equal(await pages[1]!.evaluate(() => window.liveSources.every(s=>s.readyState===2)),true); completed.push('logout closes streams');
  assert.deepEqual(errors,[]); await assertInvariants(db.pool,hid);
  console.log(JSON.stringify({passed:true,checks:completed}));
} finally {
  await browser?.close(); closeRealtime();
  await new Promise<void>((done)=>{server.close(()=>done()); server.closeAllConnections();});
  await db.dispose();
}
