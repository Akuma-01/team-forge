import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
});
try {
  for (const width of [375, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto(baseUrl);
    assert.equal(response.status(), 200);
    await page.getByRole('heading', { level: 1, name: /Find your people/ }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const health = await page.request.get(new URL('/health', baseUrl).href);
    assert.equal(health.status(), 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const ready = await page.request.get(new URL('/ready', baseUrl).href);
    assert.equal(ready.status(), 200);
    assert.deepEqual(await ready.json(), { status: 'ok' });
    const miss = await page.request.get(new URL('/api/not-implemented', baseUrl).href);
    assert.equal(miss.status(), 404);
    assert.equal((await miss.json()).error.code, 'NOT_FOUND');
    assert.deepEqual(errors, []);
    console.info(`Browser smoke passed at ${width}px: React, keyboard, layout, health, database readiness and API routing.`);
    await page.close();
  }
} finally {
  await browser.close();
}
