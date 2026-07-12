from __future__ import annotations

import logging
from pathlib import Path

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


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    config = {**entry.data, **entry.options}
    coordinator = TripCoordinator(hass, config)
    await coordinator.async_setup()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Serve the Lovelace card JS from within the integration directory
    hass.http.register_static_path(FRONTEND_URL, str(FRONTEND_PATH), cache_headers=False)

    # Auto-register the Lovelace resource so the user doesn't have to do it manually
    await _async_register_lovelace_resource(hass)

    # Register REST API views
    hass.http.register_view(TripsListView)
    hass.http.register_view(TripDetailView)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.info("Mercedes Trips: integration loaded, card available at %s", FRONTEND_URL)
    return True


async def _async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """Add the card JS as a Lovelace resource if not already registered."""
    try:
        lovelace = hass.data.get("lovelace", {})
        resources = lovelace.get("resources")
        if resources is None:
            # Try via the storage-backed resource collection
            from homeassistant.components.lovelace import resources as lovelace_resources
            resource_collection = await lovelace_resources.async_get_resource_collection(hass)
            existing = [r["url"] for r in resource_collection.async_items()]
            if FRONTEND_URL not in existing:
                await resource_collection.async_create_item(
                    {"res_type": "module", "url": FRONTEND_URL}
                )
                _LOGGER.info("Mercedes Trips: Lovelace resource registered at %s", FRONTEND_URL)
    except Exception as exc:
        _LOGGER.warning(
            "Mercedes Trips: could not auto-register Lovelace resource (%s). "
            "Add manually: Ajustes → Dashboards → Recursos → %s (JavaScript Module)",
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
