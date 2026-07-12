from __future__ import annotations

import logging
from pathlib import Path

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .coordinator import TripCoordinator
from .http_views import TripDetailView, TripsListView

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

FRONTEND_SCRIPT = "mercedes-trips-card.js"
FRONTEND_URL = f"/{DOMAIN}/{FRONTEND_SCRIPT}"
FRONTEND_PATH = Path(__file__).parent / "frontend" / FRONTEND_SCRIPT


class MercedesTripsCardView(HomeAssistantView):
    """Serve the Lovelace card JS file — no auth so the browser can load it."""

    url = FRONTEND_URL
    name = f"{DOMAIN}:card"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        try:
            content = await request.app["hass"].async_add_executor_job(
                FRONTEND_PATH.read_text, "utf-8"
            )
            return web.Response(
                content_type="application/javascript",
                text=content,
                headers={"Cache-Control": "no-cache"},
            )
        except Exception as exc:
            _LOGGER.error("Mercedes Trips: could not serve card JS: %s", exc)
            return web.Response(status=500, text=str(exc))


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    config = {**entry.data, **entry.options}
    coordinator = TripCoordinator(hass, config)
    await coordinator.async_setup()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Serve the Lovelace card and REST API
    hass.http.register_view(MercedesTripsCardView)
    hass.http.register_view(TripsListView)
    hass.http.register_view(TripDetailView)

    # Try to auto-register the Lovelace resource
    await _async_register_lovelace_resource(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.info("Mercedes Trips: loaded — card at %s", FRONTEND_URL)
    return True


async def _async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """Add the card as a Lovelace resource if not already registered."""
    try:
        from homeassistant.components.lovelace import resources as lovelace_res

        collection = await lovelace_res.async_get_resource_collection(hass)
        existing_urls = {item["url"] for item in collection.async_items()}

        if FRONTEND_URL not in existing_urls:
            await collection.async_create_item({"res_type": "module", "url": FRONTEND_URL})
            _LOGGER.info("Mercedes Trips: Lovelace resource auto-registered (%s)", FRONTEND_URL)
        else:
            _LOGGER.debug("Mercedes Trips: Lovelace resource already registered")
    except Exception as exc:
        _LOGGER.warning(
            "Mercedes Trips: auto-registro del recurso Lovelace fallido (%s). "
            "Añádelo manualmente: Ajustes → Dashboards → Recursos → %s (JavaScript Module)",
            exc,
            FRONTEND_URL,
        )


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator: TripCoordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_unload()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
