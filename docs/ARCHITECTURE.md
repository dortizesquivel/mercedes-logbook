# Architecture

Mercedes Trips has two parts: a Home Assistant integration in Python, which turns the car's state into a logbook of trips, and a dashboard card in JavaScript, which shows them. The integration doesn't talk to Mercedes: it reads the entities of [mbapi2020](https://github.com/ReneNulschDE/mbapi2020), which does.

```
 Mercedes me ──► mbapi2020 ──► entity states ──► coordinator ──► SQLite (/config/mercedes_trips.db)
  (the car,       (separate     (odometer, GPS,    (trip            trips + geocode cache
   its cloud)      integration)  state of charge)   detection)  ──► .storage (trip in progress)
                                                       │    ▲    ──► 7 sensors
                                                       ▼    │
                                         Nominatim (start/end addresses, once per place)

 browser ──► /api/mercedes_trips/* (signed-in users) ──► coordinator's queries ──► JSON
    │
    └── the card: Leaflet map ◄── tiles from tile.openstreetmap.org
```

## Components

| File | Role |
|---|---|
| `custom_components/mercedes_trips/__init__.py` | Setup. Once per Home Assistant run, registers the API views, serves the card's JS and its `vendor/` files, and injects the card into the frontend with `add_extra_js_url`, with a hash of the file in the URL so browsers pick up a new version. Removes the dashboard resource older versions added. Each config entry gets a coordinator and the sensor platform; changing the options reloads it. |
| `coordinator.py` | `TripCoordinator`: listens to the odometer, records waypoints every 30 seconds and checks for inactivity every 2 minutes. Starts, extends and closes trips under one lock, keeps the trip in progress in `.storage`, writes finished trips to SQLite, geocodes their start and end, and answers the API's queries. |
| `http_views.py` | The REST API: `/api/mercedes_trips/trips`, `/trips/{id}` and `/totals`, for signed-in users. Parses the query parameters and runs the queries in the executor. |
| `sensor.py` | The 7 sensors, on a *Mercedes Trips* service device. They don't poll: the coordinator updates them when a trip starts or closes. |
| `config_flow.py` | The setup and options form. Pre-selects one car's mbapi2020 entities, found in the entity registry by their unique ID or entity ID and grouped by device; checks the chosen entities exist. One config entry per Home Assistant. |
| `const.py` | Setting keys, defaults, intervals, file names and Nominatim's URL and user agent. |
| `translations/en.json`, `es.json` | The form's and the sensors' texts. |
| `frontend/mercedes-trips-card.js` | The card: a custom element with its own shadow DOM, no framework and no build step. Fetches trips and totals with `hass.callApi`, draws them with Leaflet, groups them by day and compares the period with the previous one. Texts in English and Spanish. |
| `frontend/vendor/` | Leaflet 1.9.4 and the Chakra Petch font, served by the integration so nothing loads from a CDN. |

## Data flow

1. **Movement.** mbapi2020 updates the odometer entity. The coordinator converts the reading to km (from miles if needed) and ignores readings that go backwards. With no trip in progress, the first reading is only a baseline; a reading more than 50 m beyond it starts a trip, from the reading before, with the GPS position and the state of charge at that moment.
2. **Driving.** Every odometer change of more than 50 m moves the trip's last movement time forward. Every 30 seconds the GPS position is added to the route if the car has moved at least 20 m. The trip in progress is saved to `.storage` after each change, so a restart doesn't lose it; a recovered trip with no movement for more than 2 hours is dropped.
3. **Closing.** Every 2 minutes, a trip without movement for the configured timeout closes. Shorter than the minimum distance, it's discarded. Otherwise the coordinator works out the distance from the odometer and the energy from the drop in state of charge and the battery capacity, adds the final position, and geocodes the start and end.
4. **Geocoding.** Coordinates are rounded to 4 decimals (about 11 m) and looked up in the cache first. A miss goes to Nominatim through Home Assistant's own HTTP session, at most one request a second, with a user agent that names the project. The address is cached; a failure isn't, so the next trip from that place tries again, and the trip keeps the bare coordinates.
5. **Saving.** The trip goes into SQLite; the stats and the last trip are read back and the sensors update.
6. **Viewing.** The card asks the API for the chosen period's trips and for the previous period's totals. Hours are filtered on the local start time stored with each trip. The card draws each route and fills in the logbook, escaping every text that came from outside.

## Trust boundaries

What crosses into the integration or the card from outside, and how it's handled, is in the [assurance case](ASSURANCE.md): entity states from mbapi2020, Nominatim's answers, the API's callers and their query parameters, the card's YAML, the map tiles, and the build and release chain.

## Tests

`tests/` (pytest, with `pytest-homeassistant-custom-component`) runs the integration in a test Home Assistant: the config and options flow, trip detection and closing, the database queries, geocoding against a mocked Nominatim, the API and the sensors; Hypothesis feeds the input handling random values. `test/browser/` (Playwright) runs the card in `test/demo.html`, with sample trips and no Home Assistant. The CI runs them, ruff, ESLint, the Leaflet audit and CodeQL on every pull request; see [Development](../README.md#development).
