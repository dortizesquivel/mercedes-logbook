# Changelog

Versions before v1.4.0 are summarised from their GitHub release titles; the release pages have the details.

## v1.5.0 - 2026-10-06

- Demo and README screenshots use public places in Madrid (8877175)
- Require HA 2026.3; single config entry; drop the unused www/ copy (8337f42)
- Geocode through HA's aiohttp session; stop caching failed lookups (d0f748d)
- Stop loading Leaflet and fonts from CDNs; fix card requests after 30 min (02d9df5)
- Bump the actions group with 3 updates (#1) (f4ee5fa)

## v1.4.0 - 2026-10-06

- Start trips on real odometer movement; fix a crash when a trip closes (f62787b)
- README: demo GIF, current screenshots, generic setup instructions (8d4f0f2)
- Add brand icon, HACS/hassfest validation and a release workflow (c047152)
- Fix "Configuration error" when the card's script beats HA's app bundle (3e2ffa9)
- Card UI in English and Spanish, following the HA user's language (a01a976)
- Register the card and views in async_setup; fix the resources lookup (f3d0b1f)
- Fix hour filter off by the UTC offset and trip detail returning 404 (515494a)
- Make setup generic: detect the car's mbapi2020 entities, no EQB defaults (4ecd63c)

## v1.3.0 - 2026-10-06

- Logbook redesign

## v1.2.1 - 2026-10-06

- Fix "Access blocked" map tiles

## v1.2.0 - 2026-08-02

- Highlight selected trip on map/list

## v1.1.3 - 2026-08-02

- Fix 500 while driving

## v1.1.2 - 2026-08-02

- Fix stat overflow + double-injection

## v1.1.1 - 2026-08-02

- Fix render crash + theme via HA tokens

## v1.1.0 - 2026-08-02

- Redesign + quick period filters

## v1.0.5 - 2026-08-02

- Cache-bust card JS URL

## v1.0.4 - 2026-08-02

- Fix trip loading hang (Leaflet L conflict)

## v1.0.3 - 2026-07-12

- Fix Leaflet map in HA + English README

## v1.0.2 - 2026-07-12

- Fix map layout

## v1.0.1 - 2026-07-12

- Fix JS injection

## v1.0.0 - 2026-07-12

- First stable release
