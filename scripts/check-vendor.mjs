// The card ships Leaflet in custom_components/mercedes_trips/frontend/vendor/, so nothing loads from a CDN.
// This checks that copy is the npm package's dist/leaflet.js byte for byte, minus its sourceMappingURL
// line (the map isn't shipped), that its licence matches, and that the card asks for that version.
//   node scripts/check-vendor.mjs           check (CI)
//   node scripts/check-vendor.mjs --write   copy the installed version in, after a leaflet bump in package.json
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const pkg = new URL('node_modules/leaflet/', root);
const vendor = new URL('custom_components/mercedes_trips/frontend/vendor/', root);
const card = new URL('custom_components/mercedes_trips/frontend/mercedes-trips-card.js', root);
const write = process.argv.includes('--write');

const { version } = JSON.parse(readFileSync(new URL('package.json', pkg), 'utf8'));
const expected = {
  'leaflet.js': readFileSync(new URL('dist/leaflet.js', pkg), 'utf8').replace(/^\/\/# sourceMappingURL=.*\n?/m, ''),
  'LICENSE-leaflet.txt': readFileSync(new URL('LICENSE', pkg), 'utf8'),
};
const cardSource = readFileSync(card, 'utf8');
const cardVersion = cardSource.match(/leaflet\.js\?v=([\w.-]+)/)?.[1];

if (write) {
  for (const [name, content] of Object.entries(expected)) writeFileSync(new URL(name, vendor), content);
  writeFileSync(card, cardSource.replace(/leaflet\.js\?v=[\w.-]+/, `leaflet.js?v=${version}`));
  console.log(`Vendored Leaflet ${version}.`);
  process.exit(0);
}

const problems = [];
for (const [name, content] of Object.entries(expected)) {
  if (readFileSync(new URL(name, vendor), 'utf8') !== content) problems.push(`vendor/${name} isn't leaflet@${version}'s`);
}
if (cardVersion !== version) problems.push(`the card loads leaflet.js?v=${cardVersion}, but leaflet@${version} is installed`);

if (problems.length) {
  console.error(`${problems.join('\n')}\nRun: node scripts/check-vendor.mjs --write`);
  process.exit(1);
}
console.log(`Vendored Leaflet is leaflet@${version} from npm.`);
