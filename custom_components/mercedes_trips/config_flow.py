from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
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
    DEFAULT_ODOMETER_ENTITY,
    DEFAULT_TRACKER_ENTITY,
    DEFAULT_SOC_ENTITY,
    DEFAULT_RANGE_ENTITY,
    DEFAULT_BATTERY_CAPACITY,
    DEFAULT_INACTIVITY_TIMEOUT,
    DEFAULT_MIN_DISTANCE,
)


def _build_schema(defaults: dict) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_ODOMETER_ENTITY,
                default=defaults.get(CONF_ODOMETER_ENTITY, DEFAULT_ODOMETER_ENTITY),
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            ),
            vol.Required(
                CONF_TRACKER_ENTITY,
                default=defaults.get(CONF_TRACKER_ENTITY, DEFAULT_TRACKER_ENTITY),
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="device_tracker")
            ),
            vol.Required(
                CONF_SOC_ENTITY,
                default=defaults.get(CONF_SOC_ENTITY, DEFAULT_SOC_ENTITY),
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            ),
            vol.Optional(
                CONF_RANGE_ENTITY,
                default=defaults.get(CONF_RANGE_ENTITY, DEFAULT_RANGE_ENTITY),
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            ),
            vol.Required(
                CONF_BATTERY_CAPACITY,
                default=defaults.get(CONF_BATTERY_CAPACITY, DEFAULT_BATTERY_CAPACITY),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=10, max=200, step=0.1, mode="box")
            ),
            vol.Required(
                CONF_INACTIVITY_TIMEOUT,
                default=defaults.get(CONF_INACTIVITY_TIMEOUT, DEFAULT_INACTIVITY_TIMEOUT),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=2, max=60, step=1, mode="box")
            ),
            vol.Required(
                CONF_MIN_TRIP_DISTANCE,
                default=defaults.get(CONF_MIN_TRIP_DISTANCE, DEFAULT_MIN_DISTANCE),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0.1, max=5, step=0.1, mode="box")
            ),
        }
    )


class MercedesTripsConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}

        if user_input is not None:
            for entity_key in (CONF_ODOMETER_ENTITY, CONF_TRACKER_ENTITY, CONF_SOC_ENTITY):
                entity_id = user_input[entity_key]
                if self.hass.states.get(entity_id) is None:
                    errors[entity_key] = "entity_not_found"

            if not errors:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="Mercedes Trips", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=_build_schema(user_input or {}),
            errors=errors,
        )

    @staticmethod
    def async_get_options_flow(config_entry):
        return MercedesTripsOptionsFlow(config_entry)


class MercedesTripsOptionsFlow(config_entries.OptionsFlow):
    def __init__(self, config_entry):
        self._config_entry = config_entry

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = {**self._config_entry.data, **self._config_entry.options}
        return self.async_show_form(
            step_id="init",
            data_schema=_build_schema(current),
        )
