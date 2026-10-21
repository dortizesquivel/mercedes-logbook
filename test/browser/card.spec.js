import { expect, test } from '@playwright/test';

// The demo's trips are relative to "today"; a fixed clock makes "today" Wednesday 21 October 2026.
const NOW = new Date('2026-10-21T12:00:00+02:00');
// A blank map tile: the tests never touch OpenStreetMap's servers.
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** Opens the demo; returns the errors and the hosts outside localhost the page talked to. */
async function openDemo(page, query = '') {
  const errors = [];
  const hosts = new Set();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => { const { hostname } = new URL(r.url()); if (hostname !== 'localhost') hosts.add(hostname); });
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ contentType: 'image/png', body: TILE }));
  await page.clock.setFixedTime(NOW);
  await page.goto(`/test/demo.html${query}`);
  await expect(trips(page)).not.toHaveCount(0);
  return { errors, hosts };
}

const card = (page) => page.locator('mercedes-trips-card');
const trips = (page) => card(page).locator('button.trip');
const chip = (page, key) => card(page).locator(`.chip[data-key="${key}"]`);

test('the last 7 days, grouped by day, with their totals', async ({ page }) => {
  const { errors, hosts } = await openDemo(page);
  await expect(trips(page)).toHaveCount(12);
  await expect(card(page).locator('.day-head')).toHaveCount(5);
  await expect(card(page).locator('.day-head').first()).toContainText('Hoy, 21 de octubre');
  await expect(card(page).locator('.day-head').nth(1)).toContainText('Ayer, 20 de octubre');
  await expect(chip(page, '7d')).toHaveAttribute('aria-pressed', 'true');

  const stats = card(page).locator('.instrument .stat-value');
  await expect(stats.nth(0)).toHaveText(/^408,9\s*km$/);
  await expect(stats.nth(1)).toHaveText('12');
  // Compared with the 7 days before, from /totals.
  await expect(card(page).locator('.instrument-caption')).toHaveText('Comparado con los 7 días anteriores');
  await expect(card(page).locator('.stat-delta').first()).toContainText('▲');

  // Every trip is on the map: a line and both ends.
  expect(await card(page).evaluate((el) => el._mapLayers.length)).toBe(36);
  expect(errors).toEqual([]);
  expect([...hosts]).toEqual(['tile.openstreetmap.org']);   // nothing else leaves the browser
});

test('quick periods and back to 7 days', async ({ page }) => {
  const { errors } = await openDemo(page);
  const back = card(page).locator('#btn-clear-filter');
  await expect(back).toBeHidden();

  await chip(page, 'today').click();
  await expect(trips(page)).toHaveCount(4);
  await expect(chip(page, 'today')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, '7d')).not.toHaveAttribute('aria-pressed');
  await expect(card(page).locator('.instrument-caption')).toHaveText('Comparado con el día anterior');

  await chip(page, 'yesterday').click();
  await expect(trips(page)).toHaveCount(2);

  await expect(back).toBeVisible();
  await back.click();
  await expect(trips(page)).toHaveCount(12);
  await expect(back).toBeHidden();
  expect(errors).toEqual([]);
});

test('a custom range with an hour window', async ({ page }) => {
  const { errors } = await openDemo(page);
  const custom = card(page).locator('#chip-custom');
  await custom.click();
  await expect(custom).toHaveAttribute('aria-expanded', 'true');
  await card(page).locator('#f-start').fill('2026-10-18');
  await card(page).locator('#f-end').fill('2026-10-21');
  await card(page).locator('#f-hour-start').selectOption('18');
  await card(page).locator('#f-hour-end').selectOption('23');
  await card(page).locator('#btn-apply-custom').click();

  // Yesterday at 19:40 and 22:34, and three days ago at 18:30.
  await expect(trips(page)).toHaveCount(3);
  await expect(trips(page).locator('.time').first()).toHaveText('22:34');
  await expect(card(page).locator('#filter-summary-text')).toContainText('de 18:00 a 23:00');
  await expect(card(page).locator('.instrument-caption')).toHaveText('Comparado con los 4 días anteriores');
  expect(errors).toEqual([]);
});

test('an empty period offers a wider one', async ({ page }) => {
  await openDemo(page);
  await card(page).locator('#chip-custom').click();
  await card(page).locator('#f-start').fill('2027-01-01');
  await card(page).locator('#f-end').fill('2027-01-31');
  await card(page).locator('#btn-apply-custom').click();
  await expect(card(page).locator('.empty-title')).toHaveText('No hay trayectos en estas fechas');
  await card(page).locator('#empty-cta').click();
  await expect(chip(page, 'month')).toHaveAttribute('aria-pressed', 'true');
  await expect(trips(page)).toHaveCount(12);
});

test('opening a trip shows its details, and clicking it again closes it', async ({ page }) => {
  const { errors } = await openDemo(page);
  const first = trips(page).first();
  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  const detail = card(page).locator('.trip-detail');
  await expect(detail).toHaveCount(1);
  await expect(detail).toContainText('Salida: Plaza de San Miguel, Sol, Madrid');
  await expect(detail).toContainText('Llegada: Calle de Alcalá, 42, Centro, Madrid');
  await expect(card(page).locator('.trip-list')).toHaveClass(/has-selection/);
  expect(await card(page).evaluate((el) => el._selectedTrip?.id)).toBe(4);

  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(detail).toHaveCount(0);
  await expect(card(page).locator('.trip-list')).not.toHaveClass(/has-selection/);
  expect(errors).toEqual([]);
});

test('English, from the user\'s language', async ({ page }) => {
  await openDemo(page, '?lang=en');
  await expect(card(page).locator('.card-title')).toHaveText('Trip logbook');
  await expect(chip(page, 'today')).toHaveText('Today');
  await expect(card(page).locator('.day-head').first()).toContainText('Today, October 21');
  await expect(card(page).locator('.instrument .stat-value').first()).toHaveText(/^408\.9\s*km$/);
});

test('light and dark follow the theme', async ({ page }) => {
  await openDemo(page);
  await expect(card(page).locator('.card')).toHaveClass(/dark/);
  await openDemo(page, '?theme=light');
  await expect(card(page).locator('.card')).not.toHaveClass(/dark/);
});

test('fits a phone without scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = await openDemo(page, '?w=360');
  const columns = await card(page).locator('.instrument').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await card(page).boundingBox();
  expect(box.width).toBeLessThanOrEqual(360);
  expect(errors).toEqual([]);
});
