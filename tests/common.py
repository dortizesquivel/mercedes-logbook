"""Constants and helpers the tests share."""

from __future__ import annotations

from homeassistant.core import HomeAssistant

from custom_components.mercedes_trips.const import (
    CONF_BATTERY_CAPACITY,
    CONF_INACTIVITY_TIMEOUT,
    CONF_MIN_TRIP_DISTANCE,
    CONF_ODOMETER_ENTITY,
    CONF_RANGE_ENTITY,
    CONF_SOC_ENTITY,
    CONF_TRACKER_ENTITY,
    DOMAIN,
)

ODOMETER = "sensor.eqb_300_odometer"
TRACKER = "device_tracker.eqb_300_device_tracker"
SOC = "sensor.eqb_300_state_of_charge"
RANGE = "sensor.eqb_300_range_electric"

CONFIG = {
    CONF_ODOMETER_ENTITY: ODOMETER,
    CONF_TRACKER_ENTITY: TRACKER,
    CONF_SOC_ENTITY: SOC,
    CONF_RANGE_ENTITY: RANGE,
    CONF_BATTERY_CAPACITY: 66.5,
    CONF_INACTIVITY_TIMEOUT: 8,
    CONF_MIN_TRIP_DISTANCE: 0.5,
}

# Public places in Madrid, like the demo.
SOL = (40.4169, -3.7035)
RETIRO = (40.4153, -3.6845)


def set_car(
    hass: HomeAssistant,
    odometer: float | str | None = 27310.0,
    soc: float | str | None = 80,
    position: tuple[float, float] | None = SOL,
    unit: str = "km",
    tracker_attrs: dict | None = None,
) -> None:
    """Set the states mbapi2020 would report. None leaves an entity untouched."""
    if odometer is not None:
        hass.states.async_set(ODOMETER, str(odometer), {"unit_of_measurement": unit})
    if soc is not None:
        hass.states.async_set(SOC, str(soc), {"unit_of_measurement": "%"})
    if position is not None:
        attrs = {"latitude": position[0], "longitude": position[1], "positionHeading": 90}
        attrs.update(tracker_attrs or {})
        hass.states.async_set(TRACKER, "not_home", attrs)


def coordinator_of(hass: HomeAssistant, entry):
    return hass.data[DOMAIN][entry.entry_id]


def make_trip(start: str, km: float = 10.0, kwh: float | None = 2.0, **extra) -> dict:
    trip = {
        "start_time": start,
        "end_time": start,
        "distance_km": km,
        "kwh_used": kwh,
        "avg_kwh_per_100km": kwh / km * 100 if kwh else None,
        "waypoints": [[*SOL, start, None]],
        "start_address": "Puerta del Sol, Sol, Madrid",
        "end_address": "Paseo del Prado, Retiro, Madrid",
    }
    trip.update(extra)
    return trip


async def insert(hass: HomeAssistant, coordinator, *trips: dict) -> list[int]:
    return [await hass.async_add_executor_job(coordinator._insert_trip, t) for t in trips]
