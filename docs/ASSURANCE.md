# Security assurance case

Why we believe Mercedes Trips meets its security requirements: what it must protect, where untrusted input comes in, which design principles it follows, which common weaknesses it counters and how that's checked. For reporting a vulnerability, see [SECURITY.md](../SECURITY.md).

## What it must protect

The integration runs inside Home Assistant with Home Assistant's own rights; the card runs in Home Assistant's frontend, with the session of whoever views the dashboard. What it handles is sensitive: where a car has been, and when. The security requirements are:

1. **No code execution from data**: nothing from entity states, Nominatim's answers, the database, the API's parameters or the card's YAML may run as code, in Home Assistant or in the frontend where the user's session lives.
2. **No unwanted changes**: the integration changes nothing outside its own database and storage file, except removing the dashboard resource entries older versions added for its own card. It has no services and controls no device.
3. **Location data stays at home**: trips and routes stay in Home Assistant. The only exceptions are the start and end coordinates of each trip, sent once per place to Nominatim for the address, and the map tiles the browser loads from OpenStreetMap. No telemetry, no other servers.
4. **Robustness**: malformed or hostile input must not crash the integration, make the API fail with an error or lock up the dashboard.
5. **Trustworthy releases**: what HACS installs must be the code in this repository, and the release zip must be built by its CI.

## Threat model and trust boundaries

| Boundary | Input | Who controls it | Main threats |
|---|---|---|---|
| Entity states | The odometer, the GPS tracker's coordinates and attributes, the state of charge | mbapi2020, Mercedes' cloud, the car, anyone who can set states | Non-numbers, infinities, huge values, a mileage in miles, odometers that go back, unexpected types (a `datetime` where text was expected) |
| Nominatim's answers | The address of a place | OpenStreetMap's editors (anyone), the network | Markup or script in street names, malformed JSON, errors, timeouts |
| The trips API | `start_date`, `end_date`, `hour_start`, `hour_end`, `limit`, `offset`, a trip id | Any logged-in Home Assistant user | SQL injection, values SQLite can't hold, huge pages |
| The card's YAML | The title | Dashboard admins | Markup in the title |
| The browser | Map tiles | OpenStreetMap's tile servers | Tiles are images drawn by Leaflet; they can't run code |
| Data at rest | `mercedes_trips.db`, the trip in progress, the recorder's history of the trip sensors | Whoever can read `/config` or Home Assistant's history | Disclosure of the location history |
| Build and release | Leaflet, the test tools, GitHub Actions, the release zip | Upstream projects, the CI | A compromised dependency or action; a tampered release file |

## Design principles applied

- **Least privilege**: the integration only reads the entities it's given and only writes its own files; the API needs a logged-in user, and Home Assistant enforces that. The card has no rights beyond the viewer's. In CI, workflow tokens are read-only except in the jobs that publish.
- **Fail-safe defaults**: an unreadable odometer is no reading, not zero; the first reading after a restart is only a baseline; a trip without a state of charge gets no energy rather than a guess; a failed address lookup leaves coordinates and is tried again next time instead of being cached; malformed API parameters are a 400 that names the parameter.
- **Complete mediation**: every state goes through `_safe_float` and `_odometer_km`; every API parameter through `_date_param` and `_int_param`; every text the card shows through `_esc()` or `textContent`.
- **Economy of mechanism**: no Python requirements beyond Home Assistant; one browser library (Leaflet), vendored; SQLite from Python's standard library; no framework in the card.
- **Open design**: everything is in this public repository; release zips carry their build provenance and can be rebuilt from their tag.

## Common weaknesses countered

| Weakness | Countermeasure |
|---|---|
| Cross-site scripting (CWE-79) | Addresses, the YAML's title and every other text is escaped with `_esc()` before it goes into the page, or set as `textContent`; that includes Leaflet's tooltips. A browser test feeds markup in addresses and the title and checks it shows as text and nothing runs. CodeQL checks for DOM XSS on every pull request. |
| SQL injection (CWE-89) | Every value is a `?` parameter. The queries' `WHERE` is assembled only from fixed clauses, and the hour filter is a fixed SQL fragment. A fuzz test checks that injection strings in the filters are compared as text and leave the database unchanged. |
| Code injection (CWE-94, CWE-95) | No `eval`, `exec`, `Function` or dynamic imports of data; JSON is parsed with `json.loads` and read field by field. |
| Improper input validation (CWE-20) | States are parsed as finite numbers, odometers must be positive and move forward, miles are converted. API dates must be real `YYYY-MM-DD` dates, hours 0–23, `limit` 1–1000, `offset` 0–1,000,000 and trip ids SQLite rowids; anything else is a 400. |
| Uncontrolled resource consumption (CWE-400) | Pages of at most 1000 trips; totals without waypoints; at most 300 points drawn per trip; one Nominatim request a second with a 10 s timeout, and each place cached. |
| Exposure of sensitive information (CWE-200) | The location history never leaves Home Assistant except as said above. Who can read it is documented: any logged-in user through the API, and the recorder's history of the two trip sensors. The card's script view, which needs no login, doesn't put errors or paths in its responses. |
| Use of components with known vulnerabilities (CWE-1395) | `npm audit` of Leaflet in CI, a check that the vendored copy is npm's byte for byte, Dependabot alerts and security updates, monthly updates. |
| Supply chain (CWE-829, CWE-494) | Locked dependencies (`npm ci`, pinned test requirements); GitHub Actions pinned to commits; release zips built only by the release workflow, signed with a build-provenance attestation that users can verify, and reproducible from their tag. |

## Evidence

- **Static analysis**: CodeQL with the `security-extended` queries on the Python, the card and the workflows, on every pull request, on `main` and weekly; ruff (with its security rules) and ESLint with no warnings tolerated.
- **Dynamic analysis**: property-based fuzzing with Hypothesis over the state parsers, the API's query parsing and handlers, and the database filters. Run against the API as it was in v1.5.0, it found two crashes (an hour or a trip id too large for SQLite made it answer 500); both were fixed, each with a regression test.
- **Tests**: the integration's tests on Home Assistant's own test harness, with a coverage floor (95 % of lines and branches), and browser tests of the card, on every pull request.
- **Releases**: `gh attestation verify mercedes_trips.zip --repo dortizesquivel/mercedes-logbook` proves a release zip came from the release workflow and a given commit; `python scripts/release.py package` at the tag rebuilds it byte for byte.
- **Process**: protected `main` (pull requests only, required checks), private vulnerability reporting, and the OpenSSF Scorecard.
