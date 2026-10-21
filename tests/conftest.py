"""Shared fixtures: a Home Assistant with the mbapi2020 entities the integration reads."""

from __future__ import annotations

from unittest.mock import patch

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.mercedes_trips.const import DOMAIN

from .common import CONFIG, RANGE, set_car


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load the integration from custom_components/ in every test."""
    return


@pytest.fixture
def hass_config_dir(hass_tmp_config_dir: str) -> str:
    """A fresh config dir per test, so each one gets its own mercedes_trips.db."""
    return hass_tmp_config_dir


@pytest.fixture
def extra_js_urls():
    """The frontend component needs the real frontend build, which tests don't have:
    mark it loaded and record the card URLs the integration injects."""
    urls: list[str] = []
    with patch(
        "custom_components.mercedes_trips.add_extra_js_url",
        side_effect=lambda hass, url, es5=False: urls.append(url),
    ):
        yield urls


@pytest.fixture
async def setup_integration(hass: HomeAssistant, extra_js_urls, aioclient_mock):
    """Set up the integration with a car that's parked at Sol."""
    hass.config.components.add("frontend")
    assert await async_setup_component(hass, "http", {})
    set_car(hass)
    hass.states.async_set(RANGE, "300")
    entry = MockConfigEntry(domain=DOMAIN, title="Mercedes Trips", data=CONFIG, unique_id=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
