from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import selector

from .const import (
    DOMAIN,
    CONF_ODOMETER_ENTITY,
    CONF_TRACKER_ENTITY,
    CONF_SOC_ENTITY,
    CONF_RANGE_ENTITY,
    CONF_BATTERY_CAPACITY,
    CONF_INACTIVITY_TIMEOUT,
    CONF_MIN_TRIP_DISTANCE,
    DEFAULT_INACTIVITY_TIMEOUT,
    DEFAULT_MIN_DISTANCE,
    MBAPI2020_DOMAIN,
)

# How mbapi2020 names each entity this integration reads: its unique_id is
# "<vin>_<key>", its default entity_id "<car name>_<display name>". Either
# is enough to recognise it, so a renamed entity_id is still found.
_MBAPI2020_ENTITIES = {
    CONF_ODOMETER_ENTITY: ("sensor", "_odometer", "_odometer"),
    CONF_TRACKER_ENTITY: ("device_tracker", "_tracker", "_device_tracker"),
    CONF_SOC_ENTITY: ("sensor", "_soc", "_state_of_charge"),
    CONF_RANGE_ENTITY: ("sensor", "_rangeelectrickm", "_range_electric"),
}


def _suggest_mbapi2020_entities(hass: HomeAssistant) -> dict:
    """Pre-select the mbapi2020 entities of one car, if there is one.

    Entities are grouped by device so all suggestions belong to the same
    vehicle when the account has several; the first car with an odometer
    wins. Nothing is suggested when mbapi2020 isn't set up.
    """
    registry = er.async_get(hass)
    by_device: dict[str | None, dict] = {}
    for entry in registry.entities.values():
        if entry.platform != MBAPI2020_DOMAIN or entry.disabled_by:
            continue
        for key, (domain, uid_suffix, eid_suffix) in _MBAPI2020_ENTITIES.items():
            if entry.domain != domain:
                continue
            if (entry.unique_id or "").lower().endswith(uid_suffix) or entry.entity_id.endswith(eid_suffix):
                by_device.setdefault(entry.device_id, {}).setdefault(key, entry.entity_id)
    for found in by_device.values():
        if CONF_ODOMETER_ENTITY in found:
            return found
    return {}


def _build_schema(values: dict) -> vol.Schema:
    """Form schema. `values` are shown pre-filled but never forced: the
    detected entities on first setup, the current settings in options."""

    def suggested(key: str) -> dict:
        return {"suggested_value": values.get(key)} if values.get(key) is not None else {}

    return vol.Schema(
        {
            vol.Required(CONF_ODOMETER_ENTITY, description=suggested(CONF_ODOMETER_ENTITY)): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            ),
            vol.Required(CONF_TRACKER_ENTITY, description=suggested(CONF_TRACKER_ENTITY)): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="device_tracker")
            ),
            vol.Required(CONF_SOC_ENTITY, description=suggested(CONF_SOC_ENTITY)): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            ),
            vol.Optional(CONF_RANGE_ENTITY, description=suggested(CONF_RANGE_ENTITY)): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            ),
            # No default: usable capacity differs per model and a wrong
            # one silently skews every kWh figure.
            vol.Required(CONF_BATTERY_CAPACITY, description=suggested(CONF_BATTERY_CAPACITY)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=5, max=250, step=0.1, mode="box", unit_of_measurement="kWh")
            ),
            vol.Required(
                CONF_INACTIVITY_TIMEOUT,
                default=values.get(CONF_INACTIVITY_TIMEOUT, DEFAULT_INACTIVITY_TIMEOUT),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=2, max=60, step=1, mode="box", unit_of_measurement="min")
            ),
            vol.Required(
                CONF_MIN_TRIP_DISTANCE,
                default=values.get(CONF_MIN_TRIP_DISTANCE, DEFAULT_MIN_DISTANCE),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0.1, max=5, step=0.1, mode="box", unit_of_measurement="km")
            ),
        }
    )


def _validate(hass: HomeAssistant, user_input: dict) -> dict:
    errors = {}
    for entity_key in (CONF_ODOMETER_ENTITY, CONF_TRACKER_ENTITY, CONF_SOC_ENTITY):
        if hass.states.get(user_input[entity_key]) is None:
            errors[entity_key] = "entity_not_found"
    return errors


class MercedesTripsConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}

        if user_input is not None:
            errors = _validate(self.hass, user_input)
            if not errors:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="Mercedes Trips", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=_build_schema(user_input or _suggest_mbapi2020_entities(self.hass)),
            errors=errors,
        )

    @staticmethod
    def async_get_options_flow(config_entry):
        return MercedesTripsOptionsFlow()


class MercedesTripsOptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        errors = {}

        if user_input is not None:
            errors = _validate(self.hass, user_input)
            if not errors:
                return self.async_create_entry(title="", data=user_input)

        current = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(
            step_id="init",
            data_schema=_build_schema(user_input or current),
            errors=errors,
        )
