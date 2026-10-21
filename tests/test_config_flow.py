"""The setup form: entity suggestions from mbapi2020, validation, one entry only, and the options."""

from __future__ import annotations

from unittest.mock import patch

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr, entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.mercedes_trips.const import (
    CONF_BATTERY_CAPACITY,
    CONF_INACTIVITY_TIMEOUT,
    CONF_ODOMETER_ENTITY,
    CONF_RANGE_ENTITY,
    CONF_SOC_ENTITY,
    CONF_TRACKER_ENTITY,
    DOMAIN,
    MBAPI2020_DOMAIN,
)

from .common import CONFIG, ODOMETER, set_car


@pytest.fixture(autouse=True)
def no_setup(hass: HomeAssistant):
    """Only the flow is under test here: its dependencies count as loaded, and
    creating the entry doesn't set the integration up."""
    hass.config.components.update({"frontend", "http"})
    with (
        patch("custom_components.mercedes_trips.async_setup", return_value=True),
        patch("custom_components.mercedes_trips.async_setup_entry", return_value=True),
    ):
        yield


def suggestions(result) -> dict:
    """What the form shows pre-filled, by field."""
    found = {}
    for key in result["data_schema"].schema:
        value = (key.description or {}).get("suggested_value")
        if value is not None:
            found[str(key)] = value
    return found


def add_car(hass: HomeAssistant, vin: str, name: str, *, keys=("odometer", "tracker", "soc", "rangeelectrickm")):
    """Register a car's entities the way mbapi2020 does: unique_id <vin>_<key>, one device per car."""
    mb_entry = MockConfigEntry(domain=MBAPI2020_DOMAIN)
    mb_entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=mb_entry.entry_id, identifiers={(MBAPI2020_DOMAIN, vin)}, name=name
    )
    registry = er.async_get(hass)
    object_ids = {
        "odometer": ("sensor", "odometer"),
        "tracker": ("device_tracker", "device_tracker"),
        "soc": ("sensor", "state_of_charge"),
        "rangeelectrickm": ("sensor", "range_electric"),
    }
    ids = {}
    for key in keys:
        domain, suffix = object_ids[key]
        entry = registry.async_get_or_create(
            domain,
            MBAPI2020_DOMAIN,
            f"{vin}_{key}",
            suggested_object_id=f"{name}_{suffix}",
            device_id=device.id,
            config_entry=mb_entry,
        )
        ids[key] = entry.entity_id
    return ids


async def test_form_suggests_the_cars_entities(hass: HomeAssistant):
    ids = add_car(hass, "W1N0000000000001", "eqb_300")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    assert suggestions(result) == {
        CONF_ODOMETER_ENTITY: ids["odometer"],
        CONF_TRACKER_ENTITY: ids["tracker"],
        CONF_SOC_ENTITY: ids["soc"],
        CONF_RANGE_ENTITY: ids["rangeelectrickm"],
    }


async def test_suggestions_come_from_one_car_with_an_odometer(hass: HomeAssistant):
    add_car(hass, "W1N0000000000001", "eqa_250", keys=("tracker", "soc"))  # no odometer
    ids = add_car(hass, "W1N0000000000002", "eqb_300")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert suggestions(result)[CONF_ODOMETER_ENTITY] == ids["odometer"]
    assert suggestions(result)[CONF_TRACKER_ENTITY] == ids["tracker"]


async def test_renamed_entity_is_still_found_by_unique_id(hass: HomeAssistant):
    ids = add_car(hass, "W1N0000000000001", "eqb_300")
    er.async_get(hass).async_update_entity(ids["odometer"], new_entity_id="sensor.my_car_km")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert suggestions(result)[CONF_ODOMETER_ENTITY] == "sensor.my_car_km"


async def test_disabled_and_foreign_entities_are_not_suggested(hass: HomeAssistant):
    ids = add_car(hass, "W1N0000000000001", "eqb_300")
    registry = er.async_get(hass)
    registry.async_update_entity(ids["odometer"], disabled_by=er.RegistryEntryDisabler.USER)
    registry.async_get_or_create("sensor", "other_integration", "x_odometer", suggested_object_id="x_odometer")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert suggestions(result) == {}


async def test_form_without_mbapi2020_suggests_nothing(hass: HomeAssistant):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert suggestions(result) == {}


async def test_missing_entities_are_reported(hass: HomeAssistant):
    hass.states.async_set(ODOMETER, "27310")  # the tracker and the SoC don't exist
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], CONFIG)
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {CONF_TRACKER_ENTITY: "entity_not_found", CONF_SOC_ENTITY: "entity_not_found"}
    # What was typed stays in the form.
    assert suggestions(result)[CONF_ODOMETER_ENTITY] == ODOMETER


async def test_valid_form_creates_the_entry(hass: HomeAssistant):
    set_car(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], CONFIG)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Mercedes Logbook"
    assert result["data"] == CONFIG
    assert result["result"].unique_id == DOMAIN


async def test_only_one_entry(hass: HomeAssistant):
    MockConfigEntry(domain=DOMAIN, data=CONFIG, unique_id=DOMAIN).add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_options_show_the_current_settings_and_save(hass: HomeAssistant):
    set_car(hass)
    entry = MockConfigEntry(domain=DOMAIN, data=CONFIG, options={CONF_BATTERY_CAPACITY: 70.5}, unique_id=DOMAIN)
    entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    shown = suggestions(result)
    assert shown[CONF_ODOMETER_ENTITY] == ODOMETER
    assert shown[CONF_BATTERY_CAPACITY] == 70.5  # options win over the original data

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {**CONFIG, CONF_INACTIVITY_TIMEOUT: 15}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options[CONF_INACTIVITY_TIMEOUT] == 15


async def test_options_validate_entities(hass: HomeAssistant):
    set_car(hass)
    entry = MockConfigEntry(domain=DOMAIN, data=CONFIG, unique_id=DOMAIN)
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {**CONFIG, CONF_TRACKER_ENTITY: "device_tracker.gone"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {CONF_TRACKER_ENTITY: "entity_not_found"}
