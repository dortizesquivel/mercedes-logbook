from __future__ import annotations

import logging
from pathlib import Path

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .coordinator import TripCoordinator
from .http_views import TripDetailView, TripsListView

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

FRONTEND_SCRIPT = "mercedes-trips-card.js"
# URL served directly by this integration (fallback)
FRONTEND_URL_LOCAL = f"/{DOMAIN}/{FRONTEND_SCRIPT}"
# URL when installed as HACS Frontend plugin
FRONTEND_URL_HACS = f"/hacsfiles/mercedes-logbook/{FRONTEND_SCRIPT}"

FRONTEND_PATH = Path(__file__).parent / "frontend" / FRONTEND_SCRIPT


class MercedesTripsCardView(HomeAssistantView):
    """Serve the Lovelace card JS — no auth required so the browser can load it."""

    url = FRONTEND_URL_LOCAL
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

    # Serve JS directly from the integration (works with or without HACS plugin)
    hass.http.register_view(MercedesTripsCardView)
    hass.http.register_view(TripsListView)
    hass.http.register_view(TripDetailView)

    # Register the Lovelace resource once HA is fully started
    @callback
    def _on_ha_started(_event=None) -> None:
        hass.async_create_task(_async_register_lovelace_resource(hass))

    if hass.is_running:
        hass.async_create_task(_async_register_lovelace_resource(hass))
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _on_ha_started)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.info("Mercedes Trips: loaded — card at %s", FRONTEND_URL_LOCAL)
    return True


async def _async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """Register the card as a Lovelace resource.

    Tries the HACS-served URL first, falls back to the locally served URL.
    Uses HA's internal storage for reliable cross-version compatibility.
    """
    # Prefer HACS URL if the plugin is installed, otherwise use local URL
    hacs_path = hass.config.path("www", "community", "mercedes-logbook", FRONTEND_SCRIPT)
    url = FRONTEND_URL_HACS if Path(hacs_path).exists() else FRONTEND_URL_LOCAL

    try:
        from homeassistant.components.lovelace import resources as lovelace_res  # noqa: PLC0415

        collection = await lovelace_res.async_get_resource_collection(hass)
        existing = {item["url"] for item in collection.async_items()}

        # Remove stale entries for this integration (both possible URLs)
        for item in list(collection.async_items()):
            if item["url"] in (FRONTEND_URL_LOCAL, FRONTEND_URL_HACS) and item["url"] != url:
                try:
                    await collection.async_delete_item(item["id"])
                except Exception:  # noqa: BLE001
                    pass

        if url not in existing:
            await collection.async_create_item({"res_type": "module", "url": url})
            _LOGGER.info("Mercedes Trips: Lovelace resource registered → %s", url)
        else:
            _LOGGER.debug("Mercedes Trips: Lovelace resource already registered (%s)", url)

    except Exception as exc:  # noqa: BLE001
        _LOGGER.warning(
            "Mercedes Trips: no se pudo auto-registrar el recurso Lovelace (%s). "
            "Añádelo manualmente: Ajustes → Dashboards → Recursos → %s (JavaScript Module)",
            exc,
            url,
        )


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator: TripCoordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_unload()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
