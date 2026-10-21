import { expect, test } from '@playwright/test';

// Text from outside (addresses from Nominatim, the title from the YAML) must show as text, never run.
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('markup in addresses and the title is shown as text', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ contentType: 'image/png', body: TILE }));
  await page.goto('/test/browser/fixtures/xss.html');

  const card = page.locator('mercedes-trips-card');
  const trips = card.locator('button.trip');
  await expect(trips).toHaveCount(2);
  await expect(card.locator('.card-title')).toHaveText(`<img src=x onerror="window.__xss = 'img'">`);
  await expect(trips.first().locator('.place').first()).toContainText('<img src=x');

  // The details, and every tooltip on the map (Leaflet sets those as HTML).
  await trips.first().click();
  await expect(card.locator('.trip-detail')).toContainText(`Calle <script>window.__xss = 'script'</script>`);
  await card.evaluate((el) => el._mapLayers.forEach((layer) => layer.getTooltip?.() && layer.openTooltip()));
  const tooltips = card.locator('.leaflet-tooltip');
  await expect(tooltips).not.toHaveCount(0);
  await expect(tooltips.first()).toContainText('<img src=x');

  // Nothing became an element: no images or SVG besides Leaflet's own (tiles, the attribution's flag),
  // no scripts, and no handler ran.
  const injected = await card.evaluate((el) => el.shadowRoot.querySelectorAll(
    'img:not(.leaflet-tile), svg:not(.leaflet-attribution-flag), script, [onerror], [onload], [onmouseover]',
  ).length);
  expect(injected).toBe(0);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(errors).toEqual([]);
});
