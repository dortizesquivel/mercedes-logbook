from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
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
        DistanceMonthSensor(coordinator),
        DistanceYearSensor(coordinator),
        KwhMonthSensor(coordinator),
        AvgConsumptionSensor(coordinator),
        TotalTripsSensor(coordinator),
        LastTripSensor(coordinator),
        ActiveTripSensor(coordinator),
    ]
    for s in sensors:
        coordinator.register_sensor(s)
    async_add_entities(sensors)


class _BaseTripSensor(SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator: TripCoordinator, unique_suffix: str) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"mercedes_trips_{unique_suffix}"

    def schedule_update_ha_state(self, force_refresh: bool = False) -> None:  # noqa: FBT001
        self.hass.async_create_task(self.async_update_ha_state(force_refresh))


class DistanceMonthSensor(_BaseTripSensor):
    _attr_icon = "mdi:map-marker-distance"
    _attr_native_unit_of_measurement = "km"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator):
        super().__init__(coordinator, "distance_month")
        self._attr_name = "Distancia este mes"

    @property
    def native_value(self):
        return round(self._coordinator.get_stats()["distance_this_month"], 1)


class DistanceYearSensor(_BaseTripSensor):
    _attr_icon = "mdi:map-marker-distance"
    _attr_native_unit_of_measurement = "km"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator):
        super().__init__(coordinator, "distance_year")
        self._attr_name = "Distancia este año"

    @property
    def native_value(self):
        return round(self._coordinator.get_stats()["distance_this_year"], 1)


class KwhMonthSensor(_BaseTripSensor):
    _attr_icon = "mdi:lightning-bolt"
    _attr_native_unit_of_measurement = "kWh"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator):
        super().__init__(coordinator, "kwh_month")
        self._attr_name = "kWh consumidos este mes"

    @property
    def native_value(self):
        return round(self._coordinator.get_stats()["kwh_this_month"], 2)


class AvgConsumptionSensor(_BaseTripSensor):
    _attr_icon = "mdi:gauge"
    _attr_native_unit_of_measurement = "kWh/100km"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator):
        super().__init__(coordinator, "avg_consumption")
        self._attr_name = "Consumo medio mensual"

    @property
    def native_value(self):
        val = self._coordinator.get_stats()["avg_kwh_per_100km"]
        return round(val, 1) if val else None


class TotalTripsSensor(_BaseTripSensor):
    _attr_icon = "mdi:counter"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    def __init__(self, coordinator):
        super().__init__(coordinator, "total_trips")
        self._attr_name = "Total trayectos"

    @property
    def native_value(self):
        return self._coordinator.get_stats()["total_trips"]


class LastTripSensor(_BaseTripSensor):
    _attr_icon = "mdi:car-arrow-right"

    def __init__(self, coordinator):
        super().__init__(coordinator, "last_trip")
        self._attr_name = "Último trayecto"

    @property
    def native_value(self):
        trip = self._coordinator.get_last_trip()
        if not trip:
            return "Sin trayectos"
        return f"{trip.get('start_address', '?')} → {trip.get('end_address', '?')}"

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

    def __init__(self, coordinator):
        super().__init__(coordinator, "active_trip")
        self._attr_name = "Trayecto en curso"

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
