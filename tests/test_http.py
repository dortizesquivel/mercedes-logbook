"""The trips API: login, the JSON it returns and how it rejects bad parameters."""

from __future__ import annotations

import sqlite3

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
import pytest

from custom_components.mercedes_trips.const import DB_FILENAME

from .common import SOL, coordinator_of, insert, make_trip, set_car

TRIPS = "/api/mercedes_trips/trips"
TOTALS = "/api/mercedes_trips/totals"


@pytest.fixture
async def trips(hass: HomeAssistant, setup_integration):
    """Three trips: two on 5 October (one at night) and one on the 6th."""
    return await insert(
        hass,
        coordinator_of(hass, setup_integration),
        make_trip("2026-10-05T08:10:00+02:00", km=12),
        make_trip("2026-10-05T22:40:00+02:00", km=3, kwh=None),
        make_trip("2026-10-06T09:00:00+02:00", km=30, kwh=6),
    )


@pytest.mark.parametrize("path", [TRIPS, TOTALS, f"{TRIPS}/1"])
async def test_login_required(hass: HomeAssistant, setup_integration, hass_client_no_auth, path):
    client = await hass_client_no_auth()
    assert (await client.get(path)).status == 401


async def test_list(hass: HomeAssistant, trips, hass_client):
    client = await hass_client()
    resp = await client.get(TRIPS)
    assert resp.status == 200
    body = await resp.json()
    assert [t["id"] for t in body["trips"]] == [3, 2, 1]
    assert body["trips"][0]["waypoints"] == [[*SOL, "2026-10-06T09:00:00+02:00", None]]  # a list, not JSON text
    assert body["stats"]["total_trips"] == 3
    assert body["active_trip"] is None


async def test_list_with_the_cards_filters(hass: HomeAssistant, trips, hass_client):
    """The parameters the card sends for a custom range with an hour window."""
    client = await hass_client()
    resp = await client.get(
        TRIPS, params={"limit": 200, "start_date": "2026-10-05", "end_date": "2026-10-05", "hour_start": 18}
    )
    assert resp.status == 200
    assert [t["id"] for t in (await resp.json())["trips"]] == [2]

    resp = await client.get(TRIPS, params={"limit": 1, "offset": 1})
    assert [t["id"] for t in (await resp.json())["trips"]] == [2]

    resp = await client.get(TRIPS, params={"start_date": "", "end_date": ""})  # empty means no filter
    assert len((await resp.json())["trips"]) == 3


async def test_totals(hass: HomeAssistant, trips, hass_client):
    client = await hass_client()
    resp = await client.get(TOTALS, params={"start_date": "2026-10-05", "end_date": "2026-10-05", "hour_end": 12})
    assert resp.status == 200
    assert await resp.json() == {"trip_count": 1, "distance_km": 12, "kwh_used": 2}


async def test_detail(hass: HomeAssistant, trips, hass_client):
    client = await hass_client()
    resp = await client.get(f"{TRIPS}/3")
    assert resp.status == 200
    trip = await resp.json()
    assert trip["distance_km"] == 30
    assert trip["waypoints"][0][:2] == list(SOL)
    assert (await client.get(f"{TRIPS}/99")).status == 404


@pytest.mark.parametrize(
    "params",
    [
        {"limit": "0"},
        {"limit": "1001"},
        {"limit": "ten"},
        {"limit": "2.5"},
        {"offset": "-1"},
        {"offset": "1000001"},
        {"offset": str(2**64)},
        {"start_date": "2026-13-01"},
        {"start_date": "2026-02-30"},
        {"start_date": "20261005"},
        {"start_date": "2026-W40-1"},
        {"end_date": "2026-10-05T00:00"},
        {"end_date": "' OR 1=1 --"},
        {"hour_start": "24"},
        {"hour_start": "-1"},
        {"hour_start": "10000000000000000000"},  # was an OverflowError in SQLite: a 500
        {"hour_end": "noon"},
    ],
)
async def test_list_rejects_bad_parameters(hass: HomeAssistant, trips, hass_client, params):
    client = await hass_client()
    resp = await client.get(TRIPS, params=params)
    assert resp.status == 400
    assert next(iter(params)) in await resp.text()  # the message names the parameter


@pytest.mark.parametrize(
    "params", [{"start_date": "yesterday"}, {"end_date": "2026-1-5"}, {"hour_start": "x"}, {"hour_end": "99"}]
)
async def test_totals_rejects_bad_parameters(hass: HomeAssistant, trips, hass_client, params):
    client = await hass_client()
    assert (await client.get(TOTALS, params=params)).status == 400


@pytest.mark.parametrize("trip_id", ["abc", "0", "-3", "1.5", str(2**63)])
async def test_detail_rejects_bad_ids(hass: HomeAssistant, trips, hass_client, trip_id):
    client = await hass_client()
    assert (await client.get(f"{TRIPS}/{trip_id}")).status == 400


async def test_unreadable_waypoints_become_an_empty_route(hass: HomeAssistant, trips, hass_client):
    conn = sqlite3.connect(hass.config.path(DB_FILENAME))
    conn.execute("UPDATE trips SET waypoints = 'not json' WHERE id = 1")
    conn.commit()
    conn.close()
    client = await hass_client()
    listed = {t["id"]: t for t in (await (await client.get(TRIPS)).json())["trips"]}
    assert listed[1]["waypoints"] == []
    assert (await (await client.get(f"{TRIPS}/1")).json())["waypoints"] == []


async def test_trip_in_progress_with_the_cars_datetimes(hass: HomeAssistant, setup_integration, hass_client):
    """mbapi2020 gives the GPS time as a datetime; the API must still answer."""
    set_car(hass, tracker_attrs={"timestamp": dt_util.utcnow()})
    set_car(hass, odometer=27312)
    await hass.async_block_till_done()
    client = await hass_client()
    resp = await client.get(TRIPS)
    assert resp.status == 200
    active = (await resp.json())["active_trip"]
    assert active["start_odometer"] == 27310
    assert isinstance(active["waypoints"][0][2], str)


async def test_unavailable_until_loaded(hass: HomeAssistant, setup_integration, hass_client):
    assert await hass.config_entries.async_unload(setup_integration.entry_id)
    client = await hass_client()
    for path in (TRIPS, TOTALS, f"{TRIPS}/1"):
        assert (await client.get(path)).status == 503
