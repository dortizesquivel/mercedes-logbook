from __future__ import annotations

import json

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import TripCoordinator


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
        hass: HomeAssistant = request.app["hass"]
        coordinator = _get_coordinator(hass)
        if coordinator is None:
            return web.Response(status=503, text="Integration not loaded")

        try:
            limit = int(request.rel_url.query.get("limit", 200))
            offset = int(request.rel_url.query.get("offset", 0))
            start_date = request.rel_url.query.get("start_date")
            end_date = request.rel_url.query.get("end_date")
            hour_start = request.rel_url.query.get("hour_start")
            hour_end = request.rel_url.query.get("hour_end")

            hour_start = int(hour_start) if hour_start is not None else None
            hour_end = int(hour_end) if hour_end is not None else None
        except (ValueError, TypeError) as exc:
            return web.Response(status=400, text=str(exc))

        trips = await hass.async_add_executor_job(
            coordinator.get_trips,
            limit,
            offset,
            start_date,
            end_date,
            hour_start,
            hour_end,
        )

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
            text=json.dumps({"trips": trips, "stats": stats, "active_trip": active}),
        )


class TripDetailView(HomeAssistantView):
    url = "/api/mercedes_trips/trips/{trip_id}"
    name = "api:mercedes_trips:trip_detail"
    requires_auth = True

    async def get(self, request: web.Request, trip_id: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        coordinator = _get_coordinator(hass)
        if coordinator is None:
            return web.Response(status=503, text="Integration not loaded")

        try:
            tid = int(trip_id)
        except ValueError:
            return web.Response(status=400, text="Invalid trip_id")

        trips = await hass.async_add_executor_job(coordinator.get_trips, 1, 0)
        # get specific trip from db
        trip = next((t for t in trips if t.get("id") == tid), None)
        if trip is None:
            return web.Response(status=404, text="Trip not found")

        if isinstance(trip.get("waypoints"), str):
            try:
                trip["waypoints"] = json.loads(trip["waypoints"])
            except (json.JSONDecodeError, TypeError):
                trip["waypoints"] = []

        return web.Response(
            content_type="application/json",
            text=json.dumps(trip),
        )
