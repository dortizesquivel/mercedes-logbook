from __future__ import annotations

from datetime import date
from functools import partial
import json
import re

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.http import KEY_HASS

from .const import DOMAIN
from .coordinator import TripCoordinator

DEFAULT_LIMIT = 200
MAX_LIMIT = 1000
# Far past any real logbook; it only keeps OFFSET inside SQLite's integer range.
MAX_OFFSET = 1_000_000
# Trip ids are SQLite rowids: a larger number can't exist and wouldn't even bind.
_MAX_TRIP_ID = 2**63 - 1
# date.fromisoformat() also takes "20261006" and week dates; the API only takes YYYY-MM-DD.
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# The whole-number parameters: default when absent, and the range they must be in.
_HOURS = {"hour_start": (None, 0, 23), "hour_end": (None, 0, 23)}
_PAGING = {"limit": (DEFAULT_LIMIT, 1, MAX_LIMIT), "offset": (0, 0, MAX_OFFSET)}


def _is_date(value: str) -> bool:
    if not _DATE_RE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:  # 2026-02-30 and the like
        return False
    return True


def _whole_number(value: str, low: int, high: int) -> int | None:
    try:
        number = int(value)
    except ValueError:
        return None
    return number if low <= number <= high else None


def _parse(query, paging: bool = False) -> tuple[dict, str | None]:
    """The filters (and with paging, limit/offset) as keyword arguments for
    get_trips() and get_trip_totals(), or the message for a 400 response.

    The message is built here, never from an exception, so nothing about the
    server can end up in a response.
    """
    params: dict = {}
    for name in ("start_date", "end_date"):
        value = query.get(name)
        if value and not _is_date(value):  # absent or empty: no filter, as before
            return {}, f"{name} must be a date, YYYY-MM-DD"
        params[name] = value or None
    for name, (default, low, high) in ({**_PAGING, **_HOURS} if paging else _HOURS).items():
        value = query.get(name)
        number = default if value is None else _whole_number(value, low, high)
        if value is not None and number is None:
            return {}, f"{name} must be a whole number from {low} to {high}"
        params[name] = number
    return params, None


def _get_coordinator(hass: HomeAssistant) -> TripCoordinator | None:
    domain_data = hass.data.get(DOMAIN, {})
    for coordinator in domain_data.values():
        if isinstance(coordinator, TripCoordinator):
            return coordinator
    return None


class TripsListView(HomeAssistantView):
    url = "/api/mercedes_trips/trips"
    name = "api:mercedes_trips:trips"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        coordinator = _get_coordinator(hass)
        if coordinator is None:
            return web.Response(status=503, text="Integration not loaded")

        params, error = _parse(request.rel_url.query, paging=True)
        if error:
            return web.Response(status=400, text=error)

        trips = await hass.async_add_executor_job(partial(coordinator.get_trips, **params))

        # Parse waypoints from JSON string to list
        for t in trips:
            if isinstance(t.get("waypoints"), str):
                try:
                    t["waypoints"] = json.loads(t["waypoints"])
                except (json.JSONDecodeError, TypeError):
                    t["waypoints"] = []

        stats = await hass.async_add_executor_job(coordinator.get_stats)
        active = coordinator.active_trip

        return web.Response(
            content_type="application/json",
            # default=str: safety net so an unexpected non-JSON-safe value
            # (e.g. a datetime slipping in from an upstream integration's
            # entity attributes) degrades to its string form instead of a
            # 500 for the whole endpoint.
            text=json.dumps({"trips": trips, "stats": stats, "active_trip": active}, default=str),
        )


class TripTotalsView(HomeAssistantView):
    """Aggregate totals for a date/hour range — no waypoints, cheap to poll.

    Used by the card to compute the "vs. previous period" delta on the
    instrument strip without re-downloading full trip rows for a range the
    user isn't even looking at.
    """

    url = "/api/mercedes_trips/totals"
    name = "api:mercedes_trips:totals"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        coordinator = _get_coordinator(hass)
        if coordinator is None:
            return web.Response(status=503, text="Integration not loaded")

        params, error = _parse(request.rel_url.query)
        if error:
            return web.Response(status=400, text=error)

        totals = await hass.async_add_executor_job(partial(coordinator.get_trip_totals, **params))
        return web.Response(content_type="application/json", text=json.dumps(totals))


class TripDetailView(HomeAssistantView):
    url = "/api/mercedes_trips/trips/{trip_id}"
    name = "api:mercedes_trips:trip_detail"
    requires_auth = True

    async def get(self, request: web.Request, trip_id: str) -> web.Response:
        hass: HomeAssistant = request.app[KEY_HASS]
        coordinator = _get_coordinator(hass)
        if coordinator is None:
            return web.Response(status=503, text="Integration not loaded")

        try:
            tid = int(trip_id)
        except ValueError:
            return web.Response(status=400, text="Invalid trip_id")
        if not 0 < tid <= _MAX_TRIP_ID:
            return web.Response(status=400, text="Invalid trip_id")

        trip = await hass.async_add_executor_job(coordinator.get_trip, tid)
        if trip is None:
            return web.Response(status=404, text="Trip not found")

        if isinstance(trip.get("waypoints"), str):
            try:
                trip["waypoints"] = json.loads(trip["waypoints"])
            except (json.JSONDecodeError, TypeError):
                trip["waypoints"] = []

        return web.Response(
            content_type="application/json",
            text=json.dumps(trip, default=str),
        )
