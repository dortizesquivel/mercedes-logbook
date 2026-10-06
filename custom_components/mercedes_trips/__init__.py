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
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
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
    # Once per HA run, not per config entry: an options change reloads the
    # entry, and the views look the coordinator up on every request anyway.
    # The card view goes first so the JS is servable as early as possible.
    hass.http.register_view(MercedesTripsCardView)
    hass.http.register_view(TripsListView)
    hass.http.register_view(TripDetailView)
    hass.http.register_view(TripTotalsView)

    # Inject the card as early as this integration gets to run. The
    # frontend is served from the start of HA's boot, and every page
    # rendered before this point lacks the card's <script> until it is
    # reloaded ("Configuration error" on the card) — so this happens here,
    # before any config entry work, not after it.
    #
    # Injection methods are tried in order, first success wins. The
    # Lovelace resource is only a FALLBACK for when none of those work, not
    # a second, simultaneous injection: registering both makes the browser
    # load the card twice per page view. Whichever path we're NOT using is
    # actively cleaned up, so upgrading from an older version that always
    # registered the resource doesn't leave a stale duplicate behind.
    injected = _inject_frontend_js(hass)

    @callback
    def _on_ha_started(_event=None) -> None:
        hass.async_create_task(_async_ensure_lovelace_resource(hass, add_new=not injected))

    if hass.is_running:
        hass.async_create_task(_async_ensure_lovelace_resource(hass, add_new=not injected))
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


def _inject_frontend_js(hass: HomeAssistant) -> bool:
    """Inject the card JS into HA frontend using multiple methods.

    Returns True as soon as one method succeeds, so the caller knows the
    Lovelace-resource fallback isn't needed (and should be actively
    cleaned up if a previous version left one registered).
    """
    # Method A: add_extra_js_url (HA 2023+, used by browser_mod and similar)
    try:
        from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415
        add_extra_js_url(hass, FRONTEND_VERSIONED_URL, False)
        _LOGGER.info("Mercedes Trips: card JS injected via add_extra_js_url → %s", FRONTEND_VERSIONED_URL)
        return True
    except (ImportError, Exception) as exc:
        _LOGGER.debug("Mercedes Trips: add_extra_js_url not available (%s)", exc)

    # Method B: async_register_extra_js_url (some HA versions)
    try:
        from homeassistant.components.frontend import async_register_extra_js_url  # noqa: PLC0415
        async_register_extra_js_url(hass, FRONTEND_VERSIONED_URL)
        _LOGGER.info("Mercedes Trips: card JS injected via async_register_extra_js_url → %s", FRONTEND_VERSIONED_URL)
        return True
    except (ImportError, Exception) as exc:
        _LOGGER.debug("Mercedes Trips: async_register_extra_js_url not available (%s)", exc)

    # Method C: direct hass.data manipulation (fallback for edge cases)
    try:
        from homeassistant.components.frontend import KEY_EXTRA_JS_URL_ES5  # noqa: PLC0415
        extra = hass.data.setdefault(KEY_EXTRA_JS_URL_ES5, [])
        # Drop any previous-version entry for this card (bare URL or an
        # older ?v=... hash) before appending the current one.
        extra[:] = [u for u in extra if u != FRONTEND_URL and not u.startswith(FRONTEND_URL + "?")]
        if FRONTEND_VERSIONED_URL not in extra:
            extra.append(FRONTEND_VERSIONED_URL)
        _LOGGER.info("Mercedes Trips: card JS injected via KEY_EXTRA_JS_URL_ES5 → %s", FRONTEND_VERSIONED_URL)
        return True
    except (ImportError, Exception) as exc:
        _LOGGER.debug("Mercedes Trips: KEY_EXTRA_JS_URL_ES5 not available (%s)", exc)

    _LOGGER.warning(
        "Mercedes Trips: could not inject the card JS automatically. "
        "Add it as a dashboard resource by hand: %s (JavaScript module)",
        FRONTEND_VERSIONED_URL,
    )
    return False


async def _async_ensure_lovelace_resource(hass: HomeAssistant, add_new: bool = True) -> None:
    """Reconcile the card's Lovelace resource entry.

    add_new=True (fallback mode, add_extra_js_url unavailable): guarantee
    a resource exists for the current versioned URL, tried via the live
    collection first, falling back to writing HA storage directly.

    add_new=False (add_extra_js_url already injected the script):
    actively remove ANY resource entry for this card, including one at the
    current URL — registering both would make the browser load the card
    twice per page view.
    """
    def _is_our_url(url: str) -> bool:
        return url == FRONTEND_URL or url.startswith(FRONTEND_URL + "?")

    def _is_stale(url: str) -> bool:
        if not add_new:
            return _is_our_url(url)
        # Matches our own bare URL or any previous ?v=<hash> of it, but not
        # the current versioned URL (which should be kept, not removed).
        return _is_our_url(url) and url != FRONTEND_VERSIONED_URL

    # ── Method 1: live collection API ─────────────────────────────────────────
    # The same collection the Dashboards → Resources page edits. It lives
    # at hass.data["lovelace"].resources (a dict key on HA before 2024.x).
    # In YAML resource mode it can't be edited and there is nothing to do.
    try:
        lovelace = hass.data.get("lovelace")
        collection = getattr(lovelace, "resources", None)
        if collection is None and isinstance(lovelace, dict):
            collection = lovelace.get("resources")
        if collection is None:
            raise RuntimeError("lovelace resources not available")
        if not hasattr(collection, "async_create_item"):
            _LOGGER.debug("Mercedes Trips: dashboard resources are in YAML mode, leaving them alone")
            return
        if hasattr(collection, "async_get_info"):
            await collection.async_get_info()  # loads storage-mode resources on first use
        items = list(collection.async_items())

        for item in items:
            if _is_stale(item["url"]):
                await collection.async_delete_item(item["id"])
                _LOGGER.info("Mercedes Trips: removed stale dashboard resource (live) → %s", item["url"])

        if not add_new:
            return

        existing_urls = {item["url"] for item in collection.async_items()}
        if FRONTEND_VERSIONED_URL not in existing_urls:
            await collection.async_create_item({"res_type": "module", "url": FRONTEND_VERSIONED_URL})
            _LOGGER.info("Mercedes Trips: registered dashboard resource (live) → %s", FRONTEND_VERSIONED_URL)
        else:
            _LOGGER.debug("Mercedes Trips: dashboard resource already registered")
        return
    except Exception as exc:
        _LOGGER.debug("Mercedes Trips: resource collection API failed (%s), writing storage directly", exc)

    # ── Method 2: write directly to HA storage ────────────────────────────────
    try:
        store = Store(hass, _LOVELACE_STORAGE_VERSION, _LOVELACE_STORAGE_KEY)
        data = await store.async_load()

        if data is None:
            data = {"items": []}

        items: list[dict] = data.get("items", [])
        kept = [item for item in items if not _is_stale(item.get("url", ""))]
        removed = len(items) - len(kept)

        if not add_new:
            if removed:
                data["items"] = kept
                await store.async_save(data)
                _LOGGER.info("Mercedes Trips: removed %d stale dashboard resource(s) from storage", removed)
            return

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
                "Mercedes Trips: dashboard resource written to storage → %s "
                "(%d stale removed, active after the next restart)",
                FRONTEND_VERSIONED_URL,
                removed,
            )
        elif removed:
            data["items"] = kept
            await store.async_save(data)
            _LOGGER.info("Mercedes Trips: removed %d stale dashboard resource(s) from storage", removed)
        else:
            _LOGGER.debug("Mercedes Trips: dashboard resource already in storage")

    except Exception as exc:
        _LOGGER.error(
            "Mercedes Trips: could not register the dashboard resource (%s). "
            "Add it by hand: Settings → Dashboards → Resources → %s (JavaScript module)",
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
