"""Reverse geocoding through Nominatim: the short address, the cache, failures and the rate limit."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import aiohttp
from homeassistant.core import HomeAssistant
import pytest

from custom_components.mercedes_trips.const import NOMINATIM_MIN_INTERVAL_SECONDS, NOMINATIM_URL, NOMINATIM_USER_AGENT

from .common import RETIRO, SOL, coordinator_of


@pytest.fixture
def no_sleep():
    with patch("custom_components.mercedes_trips.coordinator.asyncio.sleep", new=AsyncMock()) as sleep:
        yield sleep


@pytest.mark.parametrize(
    ("answer", "address"),
    [
        (
            {"address": {"road": "Calle de Alcalá", "house_number": "42", "suburb": "Centro", "city": "Madrid"}},
            "Calle de Alcalá, 42, Centro, Madrid",
        ),
        (
            {"address": {"pedestrian": "Plaza Mayor", "neighbourhood": "Sol", "town": "Madrid"}},
            "Plaza Mayor, Sol, Madrid",
        ),
        ({"address": {"path": "Camino del Pardo", "village": "El Pardo"}}, "Camino del Pardo, El Pardo"),
        ({"address": {}, "display_name": "Madrid, España"}, "Madrid, España"),
        ({}, "40.4169,-3.7035"),
    ],
)
async def test_short_address(hass: HomeAssistant, setup_integration, aioclient_mock, no_sleep, answer, address):
    aioclient_mock.get(NOMINATIM_URL, json=answer)
    assert await coordinator_of(hass, setup_integration)._geocode(*SOL) == address


async def test_request_identifies_the_app(hass: HomeAssistant, setup_integration, aioclient_mock, no_sleep):
    aioclient_mock.get(NOMINATIM_URL, json={"display_name": "Madrid"})
    await coordinator_of(hass, setup_integration)._geocode(*SOL)
    [(method, url, _data, headers)] = aioclient_mock.mock_calls
    assert method == "GET"
    assert url.query["lat"] == str(SOL[0])
    assert url.query["format"] == "jsonv2"
    assert headers["User-Agent"] == NOMINATIM_USER_AGENT


async def test_addresses_are_cached_per_place(hass: HomeAssistant, setup_integration, aioclient_mock, no_sleep):
    aioclient_mock.get(NOMINATIM_URL, json={"display_name": "Puerta del Sol"})
    coordinator = coordinator_of(hass, setup_integration)
    assert await coordinator._geocode(*SOL) == "Puerta del Sol"
    # A few metres away rounds to the same place: no second request.
    assert await coordinator._geocode(SOL[0] + 0.00002, SOL[1] - 0.00002) == "Puerta del Sol"
    assert aioclient_mock.call_count == 1


@pytest.mark.parametrize(
    "failure",
    [
        {"status": 500},
        {"status": 429},
        {"exc": TimeoutError()},
        {"exc": aiohttp.ClientConnectionError()},
        {"text": "<html>not json</html>"},
    ],
)
async def test_failures_fall_back_to_coordinates_and_are_not_cached(
    hass: HomeAssistant, setup_integration, aioclient_mock, no_sleep, failure, caplog
):
    aioclient_mock.get(NOMINATIM_URL, **failure)
    coordinator = coordinator_of(hass, setup_integration)
    assert await coordinator._geocode(*SOL) == "40.4169,-3.7035"
    assert "geocoding failed" in caplog.text

    aioclient_mock.clear_requests()
    aioclient_mock.get(NOMINATIM_URL, json={"display_name": "Puerta del Sol"})
    assert await coordinator._geocode(*SOL) == "Puerta del Sol"  # asked again, not stuck on coordinates


async def test_back_to_back_lookups_keep_to_one_a_second(
    hass: HomeAssistant, setup_integration, aioclient_mock, no_sleep
):
    aioclient_mock.get(NOMINATIM_URL, json={"display_name": "Madrid"})
    coordinator = coordinator_of(hass, setup_integration)
    await coordinator._geocode(*SOL)
    no_sleep.assert_not_awaited()
    await coordinator._geocode(*RETIRO)
    no_sleep.assert_awaited_once()
    (wait,) = no_sleep.await_args.args
    assert 1 < wait <= NOMINATIM_MIN_INTERVAL_SECONDS
