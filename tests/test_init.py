"""Setup, the card's script and its vendor files, unload and the old dashboard resource cleanup."""

from __future__ import annotations

from pathlib import Path
import re
from unittest.mock import patch

from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState, HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components import mercedes_trips
from custom_components.mercedes_trips.const import DOMAIN, STORAGE_KEY

from .common import CONFIG, coordinator_of, set_car


async def test_setup_injects_the_card_once_with_a_content_hash(hass: HomeAssistant, setup_integration, extra_js_urls):
    assert setup_integration.state is ConfigEntryState.LOADED
    assert len(extra_js_urls) == 1
    assert re.fullmatch(r"/mercedes_trips/mercedes-trips-card\.js\?v=[0-9a-f]{10}", extra_js_urls[0])
    # Seven sensors on one service device.
    assert len(hass.states.async_entity_ids("sensor")) == 7 + 3  # plus the car's own odometer, SoC and range


async def test_card_script_is_served_without_login(hass: HomeAssistant, setup_integration, hass_client_no_auth):
    client = await hass_client_no_auth()
    resp = await client.get("/mercedes_trips/mercedes-trips-card.js")
    assert resp.status == 200
    assert resp.content_type == "application/javascript"
    assert resp.headers["Cache-Control"] == "no-cache"
    assert "customElements" in await resp.text()


async def test_vendor_files_are_served(hass: HomeAssistant, setup_integration, hass_client_no_auth):
    client = await hass_client_no_auth()
    resp = await client.get("/mercedes_trips/vendor/leaflet.js")
    assert resp.status == 200
    assert "Leaflet 1.9.4" in await resp.text()
    resp = await client.get("/mercedes_trips/vendor/chakra-petch-700.woff2")
    assert resp.status == 200


async def test_card_script_error_does_not_leak_details(
    hass: HomeAssistant, setup_integration, hass_client_no_auth, tmp_path, caplog
):
    missing = tmp_path / "nowhere" / "mercedes-trips-card.js"
    client = await hass_client_no_auth()
    with patch.object(mercedes_trips, "FRONTEND_PATH", missing):
        resp = await client.get("/mercedes_trips/mercedes-trips-card.js")
    assert resp.status == 500
    text = await resp.text()
    assert "nowhere" not in text
    assert str(tmp_path) not in text
    assert "could not serve card JS" in caplog.text


def test_content_hash_falls_back_when_the_script_is_missing(tmp_path):
    with patch.object(mercedes_trips, "FRONTEND_PATH", tmp_path / "missing.js"):
        assert mercedes_trips._frontend_content_hash() == "0"
    assert re.fullmatch(r"[0-9a-f]{10}", mercedes_trips._frontend_content_hash())


async def test_unload_keeps_the_trip_in_progress(hass: HomeAssistant, setup_integration, hass_storage):
    set_car(hass, odometer=27312)
    await hass.async_block_till_done()
    assert coordinator_of(hass, setup_integration).active_trip is not None

    assert await hass.config_entries.async_unload(setup_integration.entry_id)
    await hass.async_block_till_done()
    assert setup_integration.state is ConfigEntryState.NOT_LOADED
    assert setup_integration.entry_id not in hass.data[DOMAIN]
    assert hass_storage[STORAGE_KEY]["data"]["start_odometer"] == 27310


async def test_options_change_reloads_with_the_new_settings(hass: HomeAssistant, setup_integration):
    before = coordinator_of(hass, setup_integration)
    hass.config_entries.async_update_entry(setup_integration, options={**CONFIG, "inactivity_timeout_min": 20})
    await hass.async_block_till_done()
    after = coordinator_of(hass, setup_integration)
    assert after is not before
    assert after._config["inactivity_timeout_min"] == 20


class FakeResources:
    """The dashboard resource collection, as lovelace keeps it in storage mode."""

    def __init__(self, items, fail=False):
        self.items = {item["id"]: item for item in items}
        self.fail = fail

    async def async_get_info(self):
        if self.fail:
            raise RuntimeError("storage unavailable")
        return {"resources": len(self.items)}

    def async_items(self):
        return list(self.items.values())

    async def async_delete_item(self, item_id):
        del self.items[item_id]


class FakeLovelace:
    def __init__(self, resources):
        self.resources = resources


OLD_RESOURCES = [
    {"id": "1", "url": "/mercedes_trips/mercedes-trips-card.js?v=1234567890", "type": "module"},
    {"id": "2", "url": "/mercedes_trips/mercedes-trips-card.js", "type": "module"},
    {"id": "3", "url": "/hacsfiles/other-card/other-card.js", "type": "module"},
    {"id": "4", "url": "/mercedes_trips/mercedes-trips-card.js.bak", "type": "module"},
]


async def _setup(hass: HomeAssistant) -> MockConfigEntry:
    hass.config.components.add("frontend")
    assert await async_setup_component(hass, "http", {})
    set_car(hass)
    entry = MockConfigEntry(domain=DOMAIN, data=CONFIG, unique_id=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_old_card_resources_are_removed(hass: HomeAssistant, extra_js_urls, aioclient_mock):
    resources = FakeResources(OLD_RESOURCES)
    hass.data["lovelace"] = FakeLovelace(resources)
    await _setup(hass)
    assert sorted(resources.items) == ["3", "4"]


async def test_old_card_resources_are_removed_once_started(hass: HomeAssistant, extra_js_urls, aioclient_mock):
    resources = FakeResources(OLD_RESOURCES)
    hass.data["lovelace"] = FakeLovelace(resources)
    hass.set_state(CoreState.not_running)
    await _setup(hass)
    assert len(resources.items) == 4  # not before Home Assistant has started

    hass.set_state(CoreState.running)
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
    await hass.async_block_till_done()
    assert sorted(resources.items) == ["3", "4"]


@pytest.mark.parametrize("lovelace", [None, object(), FakeLovelace(FakeResources(OLD_RESOURCES, fail=True))])
async def test_resource_cleanup_never_breaks_setup(hass: HomeAssistant, extra_js_urls, aioclient_mock, lovelace):
    if lovelace is not None:
        hass.data["lovelace"] = lovelace
    entry = await _setup(hass)
    assert entry.state is ConfigEntryState.LOADED


async def test_entry_with_options_uses_them(hass: HomeAssistant, extra_js_urls, aioclient_mock):
    hass.config.components.add("frontend")
    assert await async_setup_component(hass, "http", {})
    set_car(hass)
    entry = MockConfigEntry(
        domain=DOMAIN, data=CONFIG, options={**CONFIG, "odometer_entity": "sensor.other"}, unique_id=DOMAIN
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    coordinator = coordinator_of(hass, entry)
    assert coordinator._config["odometer_entity"] == "sensor.other"
    assert coordinator._config["tracker_entity"] == CONFIG["tracker_entity"]


def test_frontend_files_exist():
    """What the views serve ships with the integration."""
    frontend = Path(mercedes_trips.__file__).parent / "frontend"
    for name in ("mercedes-trips-card.js", "vendor/leaflet.js", "vendor/chakra-petch-600.woff2"):
        assert (frontend / name).is_file(), name
