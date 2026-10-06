from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from aiohttp import web
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.http import KEY_HASS
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .coordinator import TripCoordinator
from .http_views import TripDetailView, TripsListView, TripTotalsView

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

FRONTEND_SCRIPT = "mercedes-trips-card.js"
FRONTEND_URL = f"/{DOMAIN}/{FRONTEND_SCRIPT}"
FRONTEND_PATH = Path(__file__).parent / "frontend" / FRONTEND_SCRIPT
# Same directory layout as the card's own URL, so the card finds these
# relative to itself (new URL("vendor/…", import.meta.url)).
VENDOR_URL = f"/{DOMAIN}/vendor"
VENDOR_PATH = Path(__file__).parent / "frontend" / "vendor"


def _frontend_content_hash() -> str:
    """Short hash of the card JS content, used to cache-bust the browser/SW.

    HACS does the same thing with its `?hacstag=<id>` query param on every
    resource URL: a fixed URL lets browsers (and HA's service worker) keep
    serving a stale cached copy forever after an update. Deriving the tag
    from file content means it changes automatically whenever the JS
    changes, with no need to remember to bump a version number by hand.
    """
    try:
        return hashlib.sha1(FRONTEND_PATH.read_bytes()).hexdigest()[:10]
    except OSError:
        return "0"


FRONTEND_VERSIONED_URL = f"{FRONTEND_URL}?v={_frontend_content_hash()}"



class MercedesTripsCardView(HomeAssistantView):
    """Serve the Lovelace card JS — no auth so the browser can load it."""

    url = FRONTEND_URL
    name = f"{DOMAIN}:card"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        try:
            content = await request.app[KEY_HASS].async_add_executor_job(
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
    # Once per HA run, not per config entry: an options change reloads the
    # entry, and the views look the coordinator up on every request anyway.
    # The card view goes first so the JS is servable as early as possible.
    hass.http.register_view(MercedesTripsCardView)
    hass.http.register_view(TripsListView)
    hass.http.register_view(TripDetailView)
    hass.http.register_view(TripTotalsView)
    # Leaflet and the card's font, shipped in frontend/vendor/ so nothing
    # loads from a CDN. Their URLs carry a version, so long caching is safe.
    await hass.http.async_register_static_paths(
        [StaticPathConfig(VENDOR_URL, str(VENDOR_PATH), cache_headers=True)]
    )

    # Inject the card as early as this integration gets to run. The
    # frontend is served from the start of HA's boot, and every page
    # rendered before this point lacks the card's <script> until it is
    # reloaded ("Configuration error" on the card) — so this happens here,
    # before any config entry work, not after it.
    add_extra_js_url(hass, FRONTEND_VERSIONED_URL)
    _LOGGER.info("Mercedes Trips: card JS injected → %s", FRONTEND_VERSIONED_URL)

    # Older versions could also register the card as a dashboard
    # resource; with the injection above that would load it twice per page.
    @callback
    def _on_ha_started(_event=None) -> None:
        hass.async_create_task(_async_remove_stale_resources(hass))

    if hass.is_running:
        hass.async_create_task(_async_remove_stale_resources(hass))
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _on_ha_started)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})

    config = {**entry.data, **entry.options}
    coordinator = TripCoordinator(hass, config)
    await coordinator.async_setup()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.info("Mercedes Trips: loaded — card at %s", FRONTEND_VERSIONED_URL)
    return True


async def _async_remove_stale_resources(hass: HomeAssistant) -> None:
    """Remove dashboard resource entries an older version added for the card.

    Uses the resource collection's own API (what Settings → Dashboards →
    Resources edits), never .storage directly. Nothing to do when resources
    are defined in YAML.
    """
    collection = getattr(hass.data.get("lovelace"), "resources", None)
    if collection is None or not hasattr(collection, "async_delete_item"):
        return
    try:
        await collection.async_get_info()  # loads storage-mode resources on first use
        for item in list(collection.async_items()):
            url = item.get("url", "")
            if url == FRONTEND_URL or url.startswith(FRONTEND_URL + "?"):
                await collection.async_delete_item(item["id"])
                _LOGGER.info("Mercedes Trips: removed old dashboard resource → %s", url)
    except Exception as exc:  # noqa: BLE001 — housekeeping must never break setup
        _LOGGER.debug("Mercedes Trips: could not check dashboard resources (%s)", exc)


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator: TripCoordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_unload()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
