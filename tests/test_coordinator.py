"""Trip detection from the odometer, the GPS route, closing a trip, energy, recovery and the database."""

from __future__ import annotations

from datetime import timedelta
import json
import sqlite3
from unittest.mock import patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMockResponse

from custom_components.mercedes_trips.const import DB_FILENAME, DOMAIN, NOMINATIM_URL, STORAGE_KEY
from custom_components.mercedes_trips.coordinator import _haversine_km

from .common import CONFIG, ODOMETER, RETIRO, SOL, coordinator_of, insert, make_trip, set_car

ADDRESSES = {
    SOL: {"road": "Puerta del Sol", "suburb": "Sol", "city": "Madrid"},
    RETIRO: {"road": "Plaza de la Independencia", "house_number": "1", "suburb": "Retiro", "city": "Madrid"},
}


@pytest.fixture(autouse=True)
def no_geocode_spacing():
    """Back-to-back lookups would wait 1.1 s; the spacing has its own test."""
    with patch("custom_components.mercedes_trips.coordinator.NOMINATIM_MIN_INTERVAL_SECONDS", 0):
        yield


@pytest.fixture
def nominatim(aioclient_mock):
    """Nominatim answering with the address of whichever of the two places is asked for."""

    async def reply(method, url, data):
        lat, lon = float(url.query["lat"]), float(url.query["lon"])
        place = min(ADDRESSES, key=lambda p: _haversine_km(lat, lon, *p))
        return AiohttpClientMockResponse(method, url, json={"address": ADDRESSES[place]})

    aioclient_mock.get(NOMINATIM_URL, side_effect=reply)
    return aioclient_mock


async def move(hass: HomeAssistant, **states) -> None:
    set_car(hass, **{"odometer": None, "soc": None, "position": None, **states})
    await hass.async_block_till_done()


async def advance(hass: HomeAssistant, freezer: FrozenDateTimeFactory, **delta) -> None:
    freezer.tick(timedelta(**delta))
    async_fire_time_changed(hass)
    # The interval checks run as background tasks.
    await hass.async_block_till_done(wait_background_tasks=True)


def saved_trips(hass: HomeAssistant) -> list[dict]:
    conn = sqlite3.connect(hass.config.path(DB_FILENAME))
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM trips ORDER BY id")]
    finally:
        conn.close()


# ── Detection ────────────────────────────────────────────────────────────────


async def test_trip_starts_on_real_movement(hass: HomeAssistant, setup_integration):
    coordinator = coordinator_of(hass, setup_integration)
    assert coordinator.active_trip is None
    assert hass.states.get("sensor.mercedes_logbook_trip_in_progress").state == "idle"

    await move(hass, odometer=27310.03)  # jitter, not movement
    assert coordinator.active_trip is None

    await move(hass, odometer=27311.2)
    trip = coordinator.active_trip
    assert trip["start_odometer"] == 27310.03  # from the reading before the movement
    assert trip["stable_odometer"] == 27311.2
    assert trip["start_soc"] == 80
    assert (trip["start_lat"], trip["start_lon"]) == SOL
    assert trip["waypoints"][0][:2] == list(SOL)
    assert trip["waypoints"][0][3] == 90  # heading
    assert hass.states.get("sensor.mercedes_logbook_trip_in_progress").state == "active"


async def test_first_reading_is_only_a_baseline(hass: HomeAssistant, extra_js_urls, aioclient_mock):
    """After a restart, or with the car unavailable, the first reading can't start a trip."""
    from homeassistant.setup import async_setup_component

    hass.config.components.add("frontend")
    assert await async_setup_component(hass, "http", {})
    set_car(hass, odometer="unavailable")
    entry = MockConfigEntry(domain=DOMAIN, data=CONFIG, unique_id=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    coordinator = coordinator_of(hass, entry)

    await move(hass, odometer=27310)
    assert coordinator.active_trip is None
    await move(hass, odometer=27312)
    assert coordinator.active_trip["start_odometer"] == 27310


@pytest.mark.parametrize("state", ["unknown", "unavailable", "", "abc", "0", "-5", "nan", "inf"])
async def test_unreadable_odometer_is_ignored(hass: HomeAssistant, setup_integration, state):
    coordinator = coordinator_of(hass, setup_integration)
    await move(hass, odometer=state)
    assert coordinator.active_trip is None
    assert coordinator._last_odometer == 27310
    await move(hass, odometer=27312)
    assert coordinator.active_trip["start_odometer"] == 27310


async def test_odometer_going_back_is_ignored(hass: HomeAssistant, setup_integration):
    coordinator = coordinator_of(hass, setup_integration)
    await move(hass, odometer=27315)
    await move(hass, odometer=27300)
    assert coordinator._last_odometer == 27315
    assert coordinator.active_trip["stable_odometer"] == 27315


async def test_miles_are_stored_as_km(hass: HomeAssistant, setup_integration):
    coordinator = coordinator_of(hass, setup_integration)
    await move(hass, odometer=16970, unit="mi")  # ≈ 27311 km
    trip = coordinator.active_trip
    assert trip["stable_odometer"] == pytest.approx(16970 * 1.609344)
    assert trip["start_odometer"] == 27310


async def test_movement_while_driving_updates_the_last_movement(
    hass: HomeAssistant, setup_integration, freezer: FrozenDateTimeFactory
):
    coordinator = coordinator_of(hass, setup_integration)
    await move(hass, odometer=27312)
    started = coordinator.active_trip["last_movement"]
    freezer.tick(timedelta(minutes=3))
    await move(hass, odometer=27312.02)  # below the threshold: not movement
    assert coordinator.active_trip["last_movement"] == started
    await move(hass, odometer=27314)
    assert coordinator.active_trip["last_movement"] > started
    assert coordinator.active_trip["stable_odometer"] == 27314


# ── Route ────────────────────────────────────────────────────────────────────


async def test_waypoints_are_recorded_while_moving(
    hass: HomeAssistant, setup_integration, freezer: FrozenDateTimeFactory
):
    coordinator = coordinator_of(hass, setup_integration)
    await move(hass, odometer=27312)
    await move(hass, position=(SOL[0] + 0.0001, SOL[1]))  # about 11 m: not worth a point
    await advance(hass, freezer, seconds=31)
    assert len(coordinator.active_trip["waypoints"]) == 1

    await move(hass, position=RETIRO, tracker_attrs={"timestamp": dt_util.utcnow()})
    await advance(hass, freezer, seconds=31)
    waypoints = coordinator.active_trip["waypoints"]
    assert len(waypoints) == 2
    assert waypoints[1][:2] == list(RETIRO)
    assert isinstance(waypoints[1][2], str)  # the car's datetime, stored as ISO text
    json.dumps(coordinator.active_trip)  # the API sends it as it is


async def test_no_waypoints_without_gps_or_trip(hass: HomeAssistant, setup_integration, freezer):
    coordinator = coordinator_of(hass, setup_integration)
    await advance(hass, freezer, seconds=31)  # no trip: nothing to record
    await move(hass, odometer=27312)
    hass.states.async_set("device_tracker.eqb_300_device_tracker", "unavailable")
    await advance(hass, freezer, seconds=31)
    assert len(coordinator.active_trip["waypoints"]) == 1


# ── Closing ──────────────────────────────────────────────────────────────────


async def test_trip_closes_after_the_timeout(
    hass: HomeAssistant, setup_integration, freezer: FrozenDateTimeFactory, nominatim
):
    coordinator = coordinator_of(hass, setup_integration)
    await move(hass, odometer=27312)
    await advance(hass, freezer, minutes=5)
    await move(hass, odometer=27320, soc=75, position=RETIRO)
    await advance(hass, freezer, seconds=31)  # a waypoint at Retiro

    await advance(hass, freezer, minutes=7)  # 7 min still: not yet
    assert coordinator.active_trip is not None

    await advance(hass, freezer, minutes=2)
    assert coordinator.active_trip is None
    [trip] = saved_trips(hass)
    kwh = round(5 / 100 * 66.5, 2)
    assert trip["distance_km"] == 10
    assert trip["start_soc"] == 80
    assert trip["end_soc"] == 75
    assert trip["soc_used"] == 5
    assert trip["kwh_used"] == kwh
    assert trip["avg_kwh_per_100km"] == round(kwh / 10 * 100, 1)
    assert trip["start_address"] == "Puerta del Sol, Sol, Madrid"
    assert trip["end_address"] == "Plaza de la Independencia, 1, Retiro, Madrid"
    assert (trip["end_lat"], trip["end_lon"]) == RETIRO
    waypoints = json.loads(trip["waypoints"])
    assert [w[:2] for w in waypoints] == [list(SOL), list(RETIRO)]  # Retiro isn't repeated at the end

    assert hass.states.get("sensor.mercedes_logbook_trip_in_progress").state == "idle"
    assert hass.states.get("sensor.mercedes_logbook_total_trips").state == "1"
    assert hass.states.get("sensor.mercedes_logbook_distance_this_month").state == "10.0"
    last = hass.states.get("sensor.mercedes_logbook_last_trip")
    assert last.state == "Puerta del Sol, Sol, Madrid → Plaza de la Independencia, 1, Retiro, Madrid"
    assert "waypoints" not in last.attributes
    assert last.attributes["distance_km"] == 10


async def test_short_trip_is_discarded(hass: HomeAssistant, setup_integration, freezer, nominatim):
    coordinator = coordinator_of(hass, setup_integration)
    await move(hass, odometer=27310.3)
    assert coordinator.active_trip is not None
    await advance(hass, freezer, minutes=10)
    assert coordinator.active_trip is None
    assert saved_trips(hass) == []
    assert nominatim.call_count == 0  # nothing looked up for a discarded trip


@pytest.mark.parametrize(
    ("end_soc", "kwh"),
    [
        ("unknown", None),  # the car slept before reporting it
        (82, None),  # charged (or regenerated) more than it used
        (80, None),  # no change
    ],
)
async def test_no_energy_without_a_soc_drop(hass: HomeAssistant, setup_integration, freezer, nominatim, end_soc, kwh):
    await move(hass, odometer=27312)
    await move(hass, odometer=27320, soc=end_soc)
    await advance(hass, freezer, minutes=10)
    [trip] = saved_trips(hass)
    assert trip["kwh_used"] == kwh
    assert trip["avg_kwh_per_100km"] is None


async def test_trip_without_gps_is_saved_without_addresses(hass: HomeAssistant, setup_integration, freezer, nominatim):
    hass.states.async_set("device_tracker.eqb_300_device_tracker", "unavailable")
    await move(hass, odometer=27312)
    await move(hass, odometer=27320)
    await advance(hass, freezer, minutes=10)
    [trip] = saved_trips(hass)
    assert trip["start_address"] == ""
    assert trip["end_address"] == ""
    assert json.loads(trip["waypoints"]) == []
    assert hass.states.get("sensor.mercedes_logbook_last_trip").state == " → "


async def test_long_addresses_fit_in_a_state(hass: HomeAssistant, setup_integration, freezer, aioclient_mock):
    aioclient_mock.get(NOMINATIM_URL, json={"display_name": "Calle " * 60})
    await move(hass, odometer=27312)
    await move(hass, odometer=27320, position=RETIRO)
    await advance(hass, freezer, minutes=10)
    assert len(hass.states.get("sensor.mercedes_logbook_last_trip").state) == 255


# ── Recovery after a restart ─────────────────────────────────────────────────


NAIVE_UTC_5_MIN_AGO = (dt_util.utcnow() - timedelta(minutes=5)).replace(tzinfo=None).isoformat()


def stored_trip(minutes_ago: float | None, **extra) -> dict:
    trip = {
        "start_time": (dt_util.now() - timedelta(minutes=40)).isoformat(),
        "start_odometer": 27300,
        "stable_odometer": 27309,
        "start_soc": 85,
        "start_lat": SOL[0],
        "start_lon": SOL[1],
        "waypoints": [[*SOL, None, None]],
    }
    if minutes_ago is not None:
        trip["last_movement"] = (dt_util.now() - timedelta(minutes=minutes_ago)).isoformat()
    trip.update(extra)
    return trip


@pytest.mark.parametrize(
    ("trip", "kept"),
    [
        (stored_trip(5), True),
        (stored_trip(5, last_movement=NAIVE_UTC_5_MIN_AGO), True),  # older versions stored naive UTC
        (stored_trip(150), False),  # over two hours without moving
        (stored_trip(None), False),
        (stored_trip(5, last_movement="not a date"), False),
    ],
)
async def test_recovered_trip(hass: HomeAssistant, hass_storage, extra_js_urls, aioclient_mock, trip, kept):
    from homeassistant.setup import async_setup_component

    hass_storage[STORAGE_KEY] = {"version": 1, "minor_version": 1, "key": STORAGE_KEY, "data": trip}
    hass.config.components.add("frontend")
    assert await async_setup_component(hass, "http", {})
    set_car(hass)
    entry = MockConfigEntry(domain=DOMAIN, data=CONFIG, unique_id=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert (coordinator_of(hass, entry).active_trip is not None) is kept


# ── Database ─────────────────────────────────────────────────────────────────


async def test_trip_queries(hass: HomeAssistant, setup_integration):
    coordinator = coordinator_of(hass, setup_integration)
    await insert(
        hass,
        coordinator,
        make_trip("2026-10-04T08:10:00+02:00"),
        make_trip("2026-10-05T23:30:00+02:00", km=5, kwh=None),  # 21:30 UTC
        make_trip("2026-10-06T00:15:00+02:00", km=20, kwh=4),  # still 5 October in UTC
    )

    def trips(**filters):
        return [t["start_time"][:16] for t in coordinator.get_trips(**filters)]

    assert trips() == ["2026-10-06T00:15", "2026-10-05T23:30", "2026-10-04T08:10"]  # newest first
    assert trips(start_date="2026-10-05", end_date="2026-10-05") == ["2026-10-05T23:30"]
    assert trips(start_date="2026-10-06") == ["2026-10-06T00:15"]
    # Hours are the local time the trip started, not UTC.
    assert trips(hour_start=23) == ["2026-10-05T23:30"]
    assert trips(hour_end=0) == ["2026-10-06T00:15"]
    assert trips(hour_start=8, hour_end=8) == ["2026-10-04T08:10"]
    assert trips(limit=1, offset=1) == ["2026-10-05T23:30"]

    assert coordinator.get_trip_totals() == {"trip_count": 3, "distance_km": 35, "kwh_used": 6}
    assert coordinator.get_trip_totals(start_date="2026-10-05", hour_start=12) == {
        "trip_count": 1,
        "distance_km": 5,
        "kwh_used": 0,
    }
    assert coordinator.get_trip_totals(start_date="2030-01-01") == {"trip_count": 0, "distance_km": 0, "kwh_used": 0}

    first = coordinator.get_trip(1)
    assert first["start_time"] == "2026-10-04T08:10:00+02:00"
    assert coordinator.get_trip(99) is None


async def test_stats(hass: HomeAssistant, setup_integration, freezer: FrozenDateTimeFactory):
    freezer.move_to("2026-10-21T12:00:00+02:00")
    coordinator = coordinator_of(hass, setup_integration)
    assert coordinator.get_stats() == {
        "distance_this_month": 0,
        "distance_this_year": 0,
        "kwh_this_month": 0,
        "avg_kwh_per_100km": 0,
        "total_trips": 0,
    }
    await insert(
        hass,
        coordinator,
        make_trip("2026-10-02T09:00:00+02:00", km=10, kwh=2),
        make_trip("2026-10-20T09:00:00+02:00", km=30, kwh=9),
        make_trip("2026-03-01T09:00:00+01:00", km=100, kwh=18),
        make_trip("2025-12-31T09:00:00+01:00", km=1000, kwh=None),
    )
    stats = coordinator.get_stats()
    assert stats["distance_this_month"] == 40
    assert stats["distance_this_year"] == 140
    assert stats["kwh_this_month"] == 11
    assert stats["avg_kwh_per_100km"] == pytest.approx((20 + 30) / 2)
    assert stats["total_trips"] == 4


async def test_unknown_odometer_entity_reads_nothing(hass: HomeAssistant, setup_integration):
    coordinator = coordinator_of(hass, setup_integration)
    hass.states.async_remove(ODOMETER)
    assert coordinator._get_odometer() is None
    hass.states.async_set("sensor.eqb_300_state_of_charge", "unknown")
    assert coordinator._get_soc() is None
