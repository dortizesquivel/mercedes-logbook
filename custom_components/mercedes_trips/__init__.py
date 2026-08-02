from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import Path

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .coordinator import TripCoordinator
from .http_views import TripDetailView, TripsListView

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

FRONTEND_SCRIPT = "mercedes-trips-card.js"
FRONTEND_URL = f"/{DOMAIN}/{FRONTEND_SCRIPT}"
FRONTEND_PATH = Path(__file__).parent / "frontend" / FRONTEND_SCRIPT


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

# Same key/version HA uses internally for lovelace resources
_LOVELACE_STORAGE_KEY = "lovelace_resources"
_LOVELACE_STORAGE_VERSION = 1


class MercedesTripsCardView(HomeAssistantView):
    """Serve the Lovelace card JS — no auth so the browser can load it."""

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

    hass.http.register_view(MercedesTripsCardView)
    hass.http.register_view(TripsListView)
    hass.http.register_view(TripDetailView)

    # Inject JS into frontend — tried in order, first success wins
    _inject_frontend_js(hass)

    # Also persist in Lovelace storage as fallback
    @callback
    def _on_ha_started(_event=None) -> None:
        hass.async_create_task(_async_ensure_lovelace_resource(hass))

    if hass.is_running:
        hass.async_create_task(_async_ensure_lovelace_resource(hass))
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _on_ha_started)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.info("Mercedes Trips: loaded — card at %s", FRONTEND_VERSIONED_URL)
    return True


def _inject_frontend_js(hass: HomeAssistant) -> None:
    """Inject the card JS into HA frontend using multiple methods."""
    # Method A: add_extra_js_url (HA 2023+, used by browser_mod and similar)
    try:
        from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415
        add_extra_js_url(hass, FRONTEND_VERSIONED_URL, False)
        _LOGGER.info("Mercedes Trips: JS inyectado via add_extra_js_url → %s", FRONTEND_VERSIONED_URL)
        return
    except (ImportError, Exception) as exc:
        _LOGGER.debug("Mercedes Trips: add_extra_js_url no disponible (%s)", exc)

    # Method B: async_register_extra_js_url (some HA versions)
    try:
        from homeassistant.components.frontend import async_register_extra_js_url  # noqa: PLC0415
        async_register_extra_js_url(hass, FRONTEND_VERSIONED_URL)
        _LOGGER.info("Mercedes Trips: JS inyectado via async_register_extra_js_url → %s", FRONTEND_VERSIONED_URL)
        return
    except (ImportError, Exception) as exc:
        _LOGGER.debug("Mercedes Trips: async_register_extra_js_url no disponible (%s)", exc)

    # Method C: direct hass.data manipulation (fallback for edge cases)
    try:
        from homeassistant.components.frontend import KEY_EXTRA_JS_URL_ES5  # noqa: PLC0415
        extra = hass.data.setdefault(KEY_EXTRA_JS_URL_ES5, [])
        # Drop any previous-version entry for this card (bare URL or an
        # older ?v=... hash) before appending the current one.
        extra[:] = [u for u in extra if u != FRONTEND_URL and not u.startswith(FRONTEND_URL + "?")]
        if FRONTEND_VERSIONED_URL not in extra:
            extra.append(FRONTEND_VERSIONED_URL)
        _LOGGER.info("Mercedes Trips: JS inyectado via KEY_EXTRA_JS_URL_ES5 → %s", FRONTEND_VERSIONED_URL)
        return
    except (ImportError, Exception) as exc:
        _LOGGER.debug("Mercedes Trips: KEY_EXTRA_JS_URL_ES5 no disponible (%s)", exc)

    _LOGGER.warning(
        "Mercedes Trips: no se pudo inyectar el JS automáticamente. "
        "Añade manualmente el recurso Lovelace: %s (JavaScript Module)",
        FRONTEND_VERSIONED_URL,
    )


async def _async_ensure_lovelace_resource(hass: HomeAssistant) -> None:
    """Guarantee the card is registered as a Lovelace resource.

    Tries the live collection first (immediate effect).
    Falls back to writing the HA storage file directly (effective after next restart).
    """
    def _is_stale(url: str) -> bool:
        # Matches our own bare URL or any previous ?v=<hash> of it, but not
        # the current versioned URL.
        return (url == FRONTEND_URL or url.startswith(FRONTEND_URL + "?")) and url != FRONTEND_VERSIONED_URL

    # ── Method 1: live collection API ─────────────────────────────────────────
    try:
        from homeassistant.components.lovelace import resources as lovelace_res  # noqa: PLC0415

        collection = await lovelace_res.async_get_resource_collection(hass)
        items = list(collection.async_items())

        for item in items:
            if _is_stale(item["url"]):
                await collection.async_delete_item(item["id"])
                _LOGGER.info("Mercedes Trips: recurso Lovelace obsoleto eliminado (live) → %s", item["url"])

        existing_urls = {item["url"] for item in collection.async_items()}
        if FRONTEND_VERSIONED_URL not in existing_urls:
            await collection.async_create_item({"res_type": "module", "url": FRONTEND_VERSIONED_URL})
            _LOGGER.info("Mercedes Trips: recurso Lovelace registrado (live) → %s", FRONTEND_VERSIONED_URL)
        else:
            _LOGGER.debug("Mercedes Trips: recurso Lovelace ya registrado")
        return
    except Exception as exc:
        _LOGGER.debug("Mercedes Trips: collection API falló (%s), usando storage directo", exc)

    # ── Method 2: write directly to HA storage ────────────────────────────────
    try:
        store = Store(hass, _LOVELACE_STORAGE_VERSION, _LOVELACE_STORAGE_KEY)
        data = await store.async_load()

        if data is None:
            data = {"items": []}

        items: list[dict] = data.get("items", [])
        kept = [item for item in items if not _is_stale(item.get("url", ""))]
        removed = len(items) - len(kept)

        if not any(item.get("url") == FRONTEND_VERSIONED_URL for item in kept):
            kept.append(
                {
                    "id": uuid.uuid4().hex[:8],
                    "type": "module",
                    "url": FRONTEND_VERSIONED_URL,
                }
            )
            data["items"] = kept
            await store.async_save(data)
            _LOGGER.info(
                "Mercedes Trips: recurso Lovelace escrito en storage → %s "
                "(%d obsoleto(s) eliminado(s), activo tras el próximo reinicio)",
                FRONTEND_VERSIONED_URL,
                removed,
            )
        elif removed:
            data["items"] = kept
            await store.async_save(data)
            _LOGGER.info("Mercedes Trips: %d recurso(s) obsoleto(s) eliminado(s) de storage", removed)
        else:
            _LOGGER.debug("Mercedes Trips: recurso ya existe en storage")

    except Exception as exc:
        _LOGGER.error(
            "Mercedes Trips: no se pudo registrar el recurso Lovelace (%s). "
            "Añádelo manualmente: Ajustes → Dashboards → Recursos → %s (JavaScript Module)",
            exc,
            FRONTEND_VERSIONED_URL,
        )


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator: TripCoordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_unload()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
