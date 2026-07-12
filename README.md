# Mercedes Trips for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![GitHub release](https://img.shields.io/github/release/dortizesquivel/mercedes-logbook.svg)](https://github.com/dortizesquivel/mercedes-logbook/releases)
[![License: MIT](https://img.shields.io/github/license/dortizesquivel/mercedes-logbook.svg)](LICENSE)
[![HA Version](https://img.shields.io/badge/Home%20Assistant-2024.1%2B-blue.svg)](https://www.home-assistant.io/)

Automatically log every trip made with your Mercedes electric or PHEV vehicle — directly in Home Assistant, with no external services or subscriptions. Stores start/end time, distance, energy consumption (kWh), GPS waypoints, and geocoded addresses in a local SQLite database.

Includes a **Lovelace card** with a multi-trip interactive map, date/hour filters, and monthly statistics.

---

## ⚠️ Required dependency: mbapi2020

**This integration depends on [mbapi2020](https://github.com/ReneNulschDE/mbapi2020)**, a separate HACS integration that connects your Mercedes vehicle to Home Assistant via the Mercedes me API.

**You must install and configure mbapi2020 first.** It provides the vehicle sensors that Mercedes Trips reads:

| Sensor | Example entity ID |
|---|---|
| Odometer | `sensor.eqb_300_odometer` |
| GPS tracker | `device_tracker.eqb_300_device_tracker` |
| State of Charge | `sensor.eqb_300_state_of_charge` |
| Electric range | `sensor.eqb_300_range_electric` |

> Without mbapi2020, this integration has no data to work with.

**How to install mbapi2020:**
1. Open HACS → Integrations → ⋮ → Custom repositories
2. Add `https://github.com/ReneNulschDE/mbapi2020` as **Integration**
3. Install **Mercedes me API** → Restart Home Assistant
4. Go to Settings → Devices & Services → Add integration → **Mercedes me API**
5. Log in with your Mercedes me account

---

## Features

- 🗺️ **Interactive multi-trip map** with each trip drawn in a different color (Leaflet + OpenStreetMap)
- 🔍 **Date and hour filters** to focus on specific time ranges
- ⚡ **Real energy consumption** calculated from SoC delta and battery capacity
- 📍 **Automatic geocoding** of trip start and end (Nominatim/OSM — no API key needed)
- 💾 **Local SQLite database** — your data, never purged by HA recorder
- 🔄 **Odometer-based detection** — intermediate stops (supermarket, work) each count as a separate trip
- 🧲 **GPS waypoints** recorded every 30 seconds during each trip
- 🔌 **Internal REST API** for querying and filtering trips
- 📊 **7 Home Assistant sensors**: km/month, km/year, kWh/month, avg consumption, total trips, last trip, active trip

---

## Requirements

- Home Assistant 2024.1 or newer
- [HACS](https://hacs.xyz/) installed
- [mbapi2020](https://github.com/ReneNulschDE/mbapi2020) installed and configured (see above)
- A Mercedes electric or PHEV vehicle with an active Mercedes me Connect subscription

---

## Installation

### Via HACS (recommended)

1. Open HACS in Home Assistant
2. Go to **Integrations → ⋮ → Custom repositories**
3. Add `dortizesquivel/mercedes-logbook` with category **Integration**
4. Find **Mercedes Trips** and install it
5. Restart Home Assistant

The Lovelace card is automatically registered when the integration loads — no manual resource configuration needed.

### Manual

1. Download the [latest release](https://github.com/dortizesquivel/mercedes-logbook/releases)
2. Copy `custom_components/mercedes_trips/` to your `/config/custom_components/` folder
3. Restart Home Assistant

---

## Configuration

1. Go to **Settings → Devices & Services → + Add integration**
2. Search for **Mercedes Trips**
3. Fill in the form:

| Field | Description | Default (EQB 300) |
|---|---|---|
| Odometer sensor | `sensor.*_odometer` from mbapi2020 | `sensor.eqb_300_odometer` |
| GPS tracker | `device_tracker.*_device_tracker` from mbapi2020 | `device_tracker.eqb_300_device_tracker` |
| Battery sensor (SoC %) | `sensor.*_state_of_charge` from mbapi2020 | `sensor.eqb_300_state_of_charge` |
| Electric range sensor | `sensor.*_range_electric` from mbapi2020 | `sensor.eqb_300_range_electric` |
| Usable battery capacity (kWh) | See table below for your model | `66.5` (EQB 300 4MATIC) |
| Inactivity timeout (minutes) | Minutes without odometer change before closing a trip | `8` |
| Minimum trip distance (km) | Shorter trips are discarded (avoids GPS drift noise) | `0.5` |

---

## Lovelace Card

Add the card to any dashboard:

```yaml
type: custom:mercedes-trips-card
```

### Card features

- **Map**: trips as colored polylines — click any trip to zoom in and view details
- **Filters**: by start date, end date, start hour and end hour
- **Stats bar**: km this month, km this year, kWh this month, avg consumption
- **Trip list**: origin → destination, duration, km, kWh, date
- **Detail panel**: distance, energy, consumption, SoC used, GPS points, odometer start/end

---

## Sensors

| Entity | Description |
|---|---|
| `sensor.mercedes_trips_distancia_este_mes` | km driven in the current month |
| `sensor.mercedes_trips_distancia_este_ano` | km driven in the current year |
| `sensor.mercedes_trips_kwh_consumidos_este_mes` | kWh consumed in the current month |
| `sensor.mercedes_trips_consumo_medio_mensual` | Average consumption in kWh/100km (current month) |
| `sensor.mercedes_trips_total_trayectos` | Total number of logged trips |
| `sensor.mercedes_trips_ultimo_trayecto` | Last trip description with full attributes |
| `sensor.mercedes_trips_trayecto_en_curso` | `active` / `idle` with live trip data as attributes |

---

## REST API

The integration exposes an internal endpoint for querying trips:

```
GET /api/mercedes_trips/trips
```

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `start_date` | `YYYY-MM-DD` | Filter from this date |
| `end_date` | `YYYY-MM-DD` | Filter up to this date |
| `hour_start` | `0–23` | Minimum trip start hour |
| `hour_end` | `0–23` | Maximum trip start hour |
| `limit` | int | Max results (default 200) |
| `offset` | int | Pagination offset |

**Example:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://homeassistant.local:8123/api/mercedes_trips/trips?start_date=2026-07-01&limit=10"
```

**Response:**
```json
{
  "trips": [
    {
      "id": 1,
      "start_time": "2026-07-12T10:00:00",
      "end_time": "2026-07-12T10:23:00",
      "distance_km": 15.4,
      "kwh_used": 3.2,
      "avg_kwh_per_100km": 20.8,
      "start_address": "Calle Mayor 1, Algeciras",
      "end_address": "Av. Principal 5, La Línea",
      "waypoints": [[36.13, -5.45, "2026-07-12T10:00:00"], "..."]
    }
  ],
  "stats": {
    "distance_this_month": 342.5,
    "kwh_this_month": 71.3,
    "avg_kwh_per_100km": 20.8,
    "total_trips": 28
  }
}
```

---

## Database

Trips are stored in `/config/mercedes_trips.db` (SQLite). You can query it directly:

```bash
sqlite3 /config/mercedes_trips.db \
  "SELECT start_time, distance_km, kwh_used, start_address, end_address FROM trips ORDER BY start_time DESC LIMIT 10;"
```

---

## Battery capacity by model

| Model | Usable kWh |
|---|---|
| EQA 250 / 250+ / 300 / 350 | 66.5 kWh |
| EQB 250 / 300 / 350 | 66.5 kWh |
| EQC 400 | 80.0 kWh |
| EQE 300 / 350 / 500 | 90.6 kWh |
| EQS 450 / 580 | 107.8 kWh |
| GLC 300e PHEV | 17.6 kWh |
| C 300e PHEV | 17.6 kWh |

---

## Troubleshooting

**No trips appear:**
- Check that the odometer value changes in **Developer Tools → States** when driving
- Make sure mbapi2020 is connected and returning valid data (not `unavailable`)
- Check logs: **Settings → System → Logs** and filter by `mercedes_trips`

**Card shows "Custom element doesn't exist":**
- Hard refresh the browser: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)
- Check that the integration is loaded: Settings → Devices & Services → Mercedes Trips should show as **Loaded**

**Energy consumption not calculated:**
- The SoC sensor must return a valid value (not `unknown`) while driving
- Check your battery capacity setting in the integration options
- If the car goes to sleep mid-trip, the final SoC may not be captured

**mbapi2020 entities not found:**
- Open mbapi2020 settings and check which entities it exposes for your vehicle
- Update the entity IDs in Mercedes Trips options to match

---

## How it works

1. **Trip start**: detected when the odometer value increases while no trip is in progress
2. **During trip**: GPS waypoints are recorded every 30 seconds; `last_movement` is updated on each odometer change
3. **Trip end**: a background check runs every 2 minutes — if no odometer change has been detected for the configured timeout, the trip is closed
4. **Post-trip**: distance and kWh are calculated, start/end addresses are geocoded via Nominatim, and the trip is saved to SQLite
5. **Noise filtering**: trips shorter than the configured minimum distance are discarded

---

## Contributing

Issues and PRs are welcome at [github.com/dortizesquivel/mercedes-logbook](https://github.com/dortizesquivel/mercedes-logbook).

---

## License

MIT — see [LICENSE](LICENSE)
