from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.const import UnitOfEnergy, UnitOfLength
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import TripCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: TripCoordinator = hass.data[DOMAIN][entry.entry_id]

    sensors = [
        DistanceMonthSensor(coordinator, entry),
        DistanceYearSensor(coordinator, entry),
        KwhMonthSensor(coordinator, entry),
        AvgConsumptionSensor(coordinator, entry),
        TotalTripsSensor(coordinator, entry),
        LastTripSensor(coordinator, entry),
        ActiveTripSensor(coordinator, entry),
    ]
    for s in sensors:
        coordinator.register_sensor(s)
    async_add_entities(sensors, update_before_add=False)


_DEVICE_INFO_CACHE: dict[str, DeviceInfo] = {}


def _device_info(entry: ConfigEntry) -> DeviceInfo:
    if entry.entry_id not in _DEVICE_INFO_CACHE:
        # A logbook service, not the car itself — the car's own device
        # belongs to the integration that talks to it (mbapi2020).
        _DEVICE_INFO_CACHE[entry.entry_id] = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Mercedes Trips",
            entry_type=DeviceEntryType.SERVICE,
        )
    return _DEVICE_INFO_CACHE[entry.entry_id]


class _BaseTripSensor(SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: TripCoordinator, entry: ConfigEntry, unique_suffix: str) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_{unique_suffix}"
        # Names come from translations/<lang>.json under the same key.
        self._attr_translation_key = unique_suffix
        self._attr_device_info = _device_info(entry)

    @property
    def should_poll(self) -> bool:
        return False


class DistanceMonthSensor(_BaseTripSensor):
    _attr_icon = "mdi:map-marker-distance"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.KILOMETERS
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator, entry):
        super().__init__(coordinator, entry, "distance_month")

    @property
    def native_value(self):
        v = self._coordinator.stats_cache.get("distance_this_month", 0)
        return round(v, 1)


class DistanceYearSensor(_BaseTripSensor):
    _attr_icon = "mdi:map-marker-distance"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.KILOMETERS
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator, entry):
        super().__init__(coordinator, entry, "distance_year")

    @property
    def native_value(self):
        v = self._coordinator.stats_cache.get("distance_this_year", 0)
        return round(v, 1)


class KwhMonthSensor(_BaseTripSensor):
    _attr_icon = "mdi:lightning-bolt"
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = UnitOfEnergy.KILO_WATT_HOUR
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator, entry):
        super().__init__(coordinator, entry, "kwh_month")

    @property
    def native_value(self):
        v = self._coordinator.stats_cache.get("kwh_this_month", 0)
        return round(v, 2)


class AvgConsumptionSensor(_BaseTripSensor):
    _attr_icon = "mdi:gauge"
    _attr_native_unit_of_measurement = "kWh/100km"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, entry):
        super().__init__(coordinator, entry, "avg_consumption")

    @property
    def native_value(self):
        v = self._coordinator.stats_cache.get("avg_kwh_per_100km", 0)
        return round(v, 1) if v else None


class TotalTripsSensor(_BaseTripSensor):
    _attr_icon = "mdi:counter"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator, entry):
        super().__init__(coordinator, entry, "total_trips")

    @property
    def native_value(self):
        return self._coordinator.stats_cache.get("total_trips", 0)


class LastTripSensor(_BaseTripSensor):
    _attr_icon = "mdi:car-arrow-right"

    def __init__(self, coordinator, entry):
        super().__init__(coordinator, entry, "last_trip")

    @property
    def native_value(self):
        trip = self._coordinator.get_last_trip()
        if not trip:
            return None
        # HA rejects states over 255 characters; long addresses can get there.
        return f"{trip.get('start_address', '?')} → {trip.get('end_address', '?')}"[:255]

    @property
    def extra_state_attributes(self):
        trip = self._coordinator.get_last_trip()
        if not trip:
            return {}
        t = dict(trip)
        t.pop("waypoints", None)
        return t


class ActiveTripSensor(_BaseTripSensor):
    _attr_icon = "mdi:car-connected"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["active", "idle"]

    def __init__(self, coordinator, entry):
        super().__init__(coordinator, entry, "active_trip")

    @property
    def native_value(self):
        return "active" if self._coordinator.active_trip else "idle"

    @property
    def extra_state_attributes(self):
        trip = self._coordinator.active_trip
        if not trip:
            return {}
        result = dict(trip)
        result.pop("waypoints", None)
        return result
