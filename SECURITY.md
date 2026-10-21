# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: **[report a vulnerability](https://github.com/dortizesquivel/mercedes-logbook/security/advisories/new)** (the repository's Security tab → Report a vulnerability). Don't open a public issue for it. Include what you found, the version and how to reproduce it.

What to expect:

- An acknowledgement within 7 days.
- A first assessment within 14 days: whether it's confirmed and how serious it is.
- A fixed release as soon as possible, usually within 30 days for a confirmed vulnerability, published with a GitHub security advisory that credits you unless you'd rather not.
- Please keep it private until the fix is released, or for 90 days after your report, whichever comes first.

## Supported versions

Fixes go into the latest release. HACS offers it as an update.

## What the integration can do

Mercedes Trips is a Home Assistant integration (Python, running inside Home Assistant) with a dashboard card (JavaScript, running in the browser of whoever views the dashboard). It doesn't talk to Mercedes: it reads what [mbapi2020](https://github.com/ReneNulschDE/mbapi2020) already put in Home Assistant.

- **Reads** the states of the entities you pick in its settings: the odometer, the GPS tracker and the state of charge. The electric range, if you pick one, is only kept in the settings.
- **Stores** every trip, with its GPS route and its start and end addresses, in `/config/mercedes_trips.db` (SQLite), and the trip in progress in `/config/.storage/mercedes_trips.active_trip`. This is your car's location history: it goes into Home Assistant backups like the rest of `/config`.
- **Changes nothing else.** It has no services and controls no device. The only thing it touches outside its own files is a clean-up: it removes dashboard resource entries that point at its own card's script, which older versions added, through Home Assistant's resource API.
- **Shows** the trips to Home Assistant's users:
  - The trips API (`/api/mercedes_trips/…`) needs a logged-in user. **Any** Home Assistant user can read it, not only admins.
  - The *Last trip* and *Trip in progress* sensors carry their trip's start and end coordinates and addresses as attributes, so the recorder keeps them in its history for as long as it keeps other states.
  - The card's script, Leaflet and the font are served without a login. They're the same public files as in this repository.
- **Sends** out of your Home Assistant:
  - the start and end coordinates of each trip to OpenStreetMap's [Nominatim](https://nominatim.org/), to get the address. Each place is looked up once and then cached; requests identify the integration in their User-Agent and keep to Nominatim's limit of one a second.
  - In the browser, the card loads the map tiles from `tile.openstreetmap.org`, which sees the tiles it is asked for and your Home Assistant's address as the referrer.

  Nothing else: no telemetry, no other servers, no CDN. Leaflet and the card's font ship with the integration.
- **Doesn't run code it receives.** There's no `eval` or `Function` on data in the card, and no dynamic code in the integration. Text from the YAML, the database and Nominatim is escaped before it goes into the page, and every SQL query takes its values as parameters.

## How it's checked

The [assurance case](docs/ASSURANCE.md) explains in more detail why the integration meets these requirements: the threat model, the trust boundaries, the design principles and the weaknesses it counters.

- **[CodeQL](.github/workflows/codeql.yml)**: static analysis of the Python, the card and the workflows with GitHub's `security-extended` queries, on every pull request, on `main` and weekly.
- **[OpenSSF Scorecard](.github/workflows/scorecard.yml)**: the project's security practices, scored publicly.
- **[CI](.github/workflows/ci.yml)** on every pull request:
  - ruff, and the integration's tests on Home Assistant's own test harness, with a coverage floor;
  - ESLint and browser tests of the card, including one that feeds it markup in addresses and checks nothing runs;
  - `npm audit` of Leaflet, and a check that the vendored copy is byte for byte the one on npm.

  `main` only takes changes through pull requests that pass them, and the HACS and hassfest validation.
- **Fuzzing**: [property-based tests](tests/test_fuzz.py) with Hypothesis feed the odometer reading, the API's query parameters and the database filters with random and hostile input.
- **Workflows**: every action is pinned to a commit, and tokens are read-only except in the jobs that publish.
- **Dependabot**: security alerts and updates, and monthly updates of Leaflet, the test tools and GitHub Actions.

## Verifying a release

Each release carries `mercedes_trips.zip`, the integration's folder, which is what HACS installs (and what you copy when installing by hand). It has a signed build-provenance attestation: proof that the file was built by the [release workflow](.github/workflows/release.yml) from the tagged commit, not uploaded by hand. The release has it as `mercedes_trips.zip.sigstore.json` (the Sigstore bundle) and `mercedes_trips.zip.intoto.jsonl` (the signed in-toto statement). To check a downloaded copy, with the GitHub CLI:

```bash
gh attestation verify mercedes_trips.zip --repo dortizesquivel/mercedes-logbook
```

The zip holds exactly the files of `custom_components/mercedes_trips/` at the tag, and it's reproducible: checking out the tag and running `python scripts/release.py package` gives a byte for byte identical `mercedes_trips.zip`, so you can compare their SHA-256. Releases before this process (v1.5.0 and older) don't have the zip; HACS installs those from the tag's source.
