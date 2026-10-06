from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_BATTERY_CAPACITY,
    CONF_INACTIVITY_TIMEOUT,
    CONF_MIN_TRIP_DISTANCE,
    CONF_ODOMETER_ENTITY,
    CONF_SOC_ENTITY,
    CONF_TRACKER_ENTITY,
    DB_FILENAME,
    GEOCODE_PRECISION,
    INACTIVITY_CHECK_INTERVAL_SECONDS,
    NOMINATIM_MIN_INTERVAL_SECONDS,
    NOMINATIM_URL,
    NOMINATIM_USER_AGENT,
    STORAGE_KEY,
    STORAGE_VERSION,
    WAYPOINT_INTERVAL_SECONDS,
)

_LOGGER = logging.getLogger(__name__)

# start_time is stored as local ISO time with its UTC offset
# ("2026-10-06T09:57:00+02:00"). SQLite's strftime() would convert that to
# UTC first and shift the hour filter by the offset, so read the local
# hour straight from the string.
_LOCAL_HOUR_SQL = "CAST(substr(start_time, 12, 2) AS INTEGER)"

_KM_PER_MILE = 1.609344


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _safe_float(value: Any, default: float | None = None) -> float | None:
    try:
        f = float(value)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _odometer_km(state) -> float | None:
    """Odometer reading in km. Trips are always stored in km, so a car
    whose Mercedes me account reports miles is converted on the way in."""
    if state is None or state.state in ("unknown", "unavailable"):
        return None
    value = _safe_float(state.state)
    if value is None or value <= 0:
        return None  # no real car reads 0; treat it as a glitch, not a reading
    if state.attributes.get("unit_of_measurement") == "mi":
        value *= _KM_PER_MILE
    return value


class TripCoordinator:
    def __init__(self, hass: HomeAssistant, config: dict) -> None:
        self.hass = hass
        self._config = config
        self._db_path = hass.config.path(DB_FILENAME)
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._active_trip: dict | None = None
        self._listeners: list = []
        self._sensors: list = []
        self._lock = asyncio.Lock()
        self._stats_cache: dict = {
            "distance_this_month": 0,
            "distance_this_year": 0,
            "kwh_this_month": 0,
            "avg_kwh_per_100km": 0,
            "total_trips": 0,
        }
        self._last_trip_cache: dict | None = None
        self._last_geocode_request = 0.0
        # Last valid odometer reading, so a trip starts on real forward
        # movement rather than on whatever reading comes first.
        self._last_odometer: float | None = None

    # ── Setup / teardown ──────────────────────────────────────────────────────

    async def async_setup(self) -> None:
        await self.hass.async_add_executor_job(self._init_db)
        self._active_trip = await self._store.async_load() or None
        await self._refresh_cache()
        self._last_odometer = self._get_odometer()

        if self._active_trip:
            _LOGGER.info("Mercedes Trips: recovered in-progress trip from storage")
            await self._check_stale_trip()

        odometer_entity = self._config[CONF_ODOMETER_ENTITY]
        self._listeners.append(
            async_track_state_change_event(
                self.hass,
                [odometer_entity],
                self._handle_odometer_change,
            )
        )

        self._listeners.append(
            async_track_time_interval(
                self.hass,
                self._periodic_waypoint,
                timedelta(seconds=WAYPOINT_INTERVAL_SECONDS),
            )
        )
        self._listeners.append(
            async_track_time_interval(
                self.hass,
                self._periodic_inactivity_check,
                timedelta(seconds=INACTIVITY_CHECK_INTERVAL_SECONDS),
            )
        )

    async def async_unload(self) -> None:
        for remove in self._listeners:
            remove()
        self._listeners.clear()
        if self._active_trip:
            await self._store.async_save(self._active_trip)

    # Stats cache — updated after each trip close, read synchronously by sensors
    @property
    def stats_cache(self) -> dict:
        return self._stats_cache

    def register_sensor(self, sensor) -> None:
        self._sensors.append(sensor)

    def _notify_sensors(self) -> None:
        for sensor in self._sensors:
            if sensor.hass is not None:  # not added yet right after setup
                sensor.async_write_ha_state()

    # ── Database ──────────────────────────────────────────────────────────────

    def _init_db(self) -> None:
        conn = sqlite3.connect(self._db_path)
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS trips (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    start_time      TEXT NOT NULL,
                    end_time        TEXT NOT NULL,
                    start_odometer  REAL,
                    end_odometer    REAL,
                    distance_km     REAL,
                    start_soc       REAL,
                    end_soc         REAL,
                    soc_used        REAL,
                    kwh_used        REAL,
                    avg_kwh_per_100km REAL,
                    waypoints       TEXT,
                    start_lat       REAL,
                    start_lon       REAL,
                    start_address   TEXT,
                    end_lat         REAL,
                    end_lon         REAL,
                    end_address     TEXT
                );

                CREATE TABLE IF NOT EXISTS geocode_cache (
                    lat_rounded REAL NOT NULL,
                    lon_rounded REAL NOT NULL,
                    address     TEXT,
                    PRIMARY KEY (lat_rounded, lon_rounded)
                );
                """
            )
            conn.commit()
        finally:
            conn.close()

    def _insert_trip(self, trip: dict) -> int:
        conn = sqlite3.connect(self._db_path)
        try:
            cur = conn.execute(
                """
                INSERT INTO trips
                    (start_time, end_time, start_odometer, end_odometer,
                     distance_km, start_soc, end_soc, soc_used, kwh_used,
                     avg_kwh_per_100km, waypoints,
                     start_lat, start_lon, start_address,
                     end_lat, end_lon, end_address)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    trip["start_time"],
                    trip["end_time"],
                    trip.get("start_odometer"),
                    trip.get("end_odometer"),
                    trip.get("distance_km"),
                    trip.get("start_soc"),
                    trip.get("end_soc"),
                    trip.get("soc_used"),
                    trip.get("kwh_used"),
                    trip.get("avg_kwh_per_100km"),
                    json.dumps(trip.get("waypoints", [])),
                    trip.get("start_lat"),
                    trip.get("start_lon"),
                    trip.get("start_address"),
                    trip.get("end_lat"),
                    trip.get("end_lon"),
                    trip.get("end_address"),
                ),
            )
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def get_trips(
        self,
        limit: int = 100,
        offset: int = 0,
        start_date: str | None = None,
        end_date: str | None = None,
        hour_start: int | None = None,
        hour_end: int | None = None,
    ) -> list[dict]:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        try:
            where_clauses = []
            params: list = []
            if start_date:
                where_clauses.append("start_time >= ?")
                params.append(start_date)
            if end_date:
                where_clauses.append("start_time <= ?")
                params.append(end_date + "T23:59:59")
            if hour_start is not None:
                where_clauses.append(f"{_LOCAL_HOUR_SQL} >= ?")
                params.append(hour_start)
            if hour_end is not None:
                where_clauses.append(f"{_LOCAL_HOUR_SQL} <= ?")
                params.append(hour_end)

            where = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            params.extend([limit, offset])
            rows = conn.execute(
                f"SELECT * FROM trips {where} ORDER BY start_time DESC LIMIT ? OFFSET ?",
                params,
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def get_trip(self, trip_id: int) -> dict | None:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def get_trip_totals(
        self,
        start_date: str | None = None,
        end_date: str | None = None,
        hour_start: int | None = None,
        hour_end: int | None = None,
    ) -> dict:
        """Aggregate totals for a date/hour range, without the waypoints payload.

        Mirrors get_trips()'s WHERE clause so the same filters used to list
        trips can be reused for a lightweight comparison (e.g. "previous
        period" deltas) without transferring every row's full waypoints.
        """
        conn = sqlite3.connect(self._db_path)
        try:
            where_clauses = []
            params: list = []
            if start_date:
                where_clauses.append("start_time >= ?")
                params.append(start_date)
            if end_date:
                where_clauses.append("start_time <= ?")
                params.append(end_date + "T23:59:59")
            if hour_start is not None:
                where_clauses.append(f"{_LOCAL_HOUR_SQL} >= ?")
                params.append(hour_start)
            if hour_end is not None:
                where_clauses.append(f"{_LOCAL_HOUR_SQL} <= ?")
                params.append(hour_end)

            where = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            row = conn.execute(
                f"SELECT COUNT(*), SUM(distance_km), SUM(kwh_used) FROM trips {where}",
                params,
            ).fetchone()
            return {
                "trip_count": row[0] or 0,
                "distance_km": row[1] or 0,
                "kwh_used": row[2] or 0,
            }
        finally:
            conn.close()

    def get_stats(self) -> dict:
        conn = sqlite3.connect(self._db_path)
        try:
            now = dt_util.now()
            month_start = now.strftime("%Y-%m-01")
            year_start = now.strftime("%Y-01-01")

            def scalar(query, params=()):
                row = conn.execute(query, params).fetchone()
                return row[0] if row and row[0] is not None else 0

            return {
                "distance_this_month": scalar(
                    "SELECT SUM(distance_km) FROM trips WHERE start_time >= ?", (month_start,)
                ),
                "distance_this_year": scalar(
                    "SELECT SUM(distance_km) FROM trips WHERE start_time >= ?", (year_start,)
                ),
                "kwh_this_month": scalar(
                    "SELECT SUM(kwh_used) FROM trips WHERE start_time >= ?", (month_start,)
                ),
                "avg_kwh_per_100km": scalar(
                    "SELECT AVG(avg_kwh_per_100km) FROM trips WHERE start_time >= ? AND avg_kwh_per_100km > 0",
                    (month_start,),
                ),
                "total_trips": scalar("SELECT COUNT(*) FROM trips"),
            }
        finally:
            conn.close()

    def get_last_trip(self) -> dict | None:
        return self._last_trip_cache

    async def _refresh_cache(self) -> None:
        stats = await self.hass.async_add_executor_job(self.get_stats)
        self._stats_cache = stats
        trips = await self.hass.async_add_executor_job(self.get_trips, 1, 0)
        self._last_trip_cache = trips[0] if trips else None

    # ── Geocoding ─────────────────────────────────────────────────────────────

    def _get_cached_address(self, lat: float, lon: float) -> str | None:
        key_lat = round(lat, GEOCODE_PRECISION)
        key_lon = round(lon, GEOCODE_PRECISION)
        conn = sqlite3.connect(self._db_path)
        try:
            row = conn.execute(
                "SELECT address FROM geocode_cache WHERE lat_rounded=? AND lon_rounded=?",
                (key_lat, key_lon),
            ).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    def _save_cached_address(self, lat: float, lon: float, address: str) -> None:
        key_lat = round(lat, GEOCODE_PRECISION)
        key_lon = round(lon, GEOCODE_PRECISION)
        conn = sqlite3.connect(self._db_path)
        try:
            conn.execute(
                "INSERT OR REPLACE INTO geocode_cache (lat_rounded, lon_rounded, address) VALUES (?,?,?)",
                (key_lat, key_lon, address),
            )
            conn.commit()
        finally:
            conn.close()

    async def _geocode(self, lat: float, lon: float) -> str:
        cached = await self.hass.async_add_executor_job(self._get_cached_address, lat, lon)
        if cached is not None:
            return cached

        # Start and end of a trip are geocoded back to back; keep them
        # inside Nominatim's one-request-per-second limit.
        wait = self._last_geocode_request + NOMINATIM_MIN_INTERVAL_SECONDS - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_geocode_request = time.monotonic()

        try:
            session = async_get_clientsession(self.hass)
            async with session.get(
                NOMINATIM_URL,
                params={"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 16, "addressdetails": 1},
                headers={"User-Agent": NOMINATIM_USER_AGENT},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            # Not cached: a network blip mustn't pin this place to bare
            # coordinates forever. The next trip here will try again.
            _LOGGER.warning("Mercedes Trips: geocoding failed for %s,%s: %s", lat, lon, exc)
            return f"{lat:.4f},{lon:.4f}"

        parts = data.get("address", {})
        short = ", ".join(
            filter(None, [
                parts.get("road") or parts.get("pedestrian") or parts.get("path"),
                parts.get("house_number"),
                parts.get("suburb") or parts.get("neighbourhood"),
                parts.get("city") or parts.get("town") or parts.get("village"),
            ])
        )
        address = short or data.get("display_name") or f"{lat:.4f},{lon:.4f}"

        await self.hass.async_add_executor_job(self._save_cached_address, lat, lon, address)
        return address

    # ── Entity state helpers ──────────────────────────────────────────────────

    def _get_odometer(self) -> float | None:
        return _odometer_km(self.hass.states.get(self._config[CONF_ODOMETER_ENTITY]))

    def _get_soc(self) -> float | None:
        state = self.hass.states.get(self._config[CONF_SOC_ENTITY])
        if state is None or state.state in ("unknown", "unavailable"):
            return None
        return _safe_float(state.state)

    def _get_gps(self) -> tuple[float, float, float | None, str | None] | None:
        """Return (lat, lon, heading_degrees, gps_timestamp) from the device tracker.

        heading and gps_timestamp come from mbapi2020 attributes positionHeading
        and timestamp — the actual GPS fix time reported by the car, which is more
        accurate than dt_util.now() for waypoint timestamps.
        """
        state = self.hass.states.get(self._config[CONF_TRACKER_ENTITY])
        if state is None or state.state in ("unknown", "unavailable"):
            return None
        attrs = state.attributes
        lat = _safe_float(attrs.get("latitude"))
        lon = _safe_float(attrs.get("longitude"))
        if lat is None or lon is None:
            return None
        heading = _safe_float(attrs.get("positionHeading"))
        gps_ts_raw = attrs.get("timestamp")  # ISO from Mercedes API
        # mbapi2020 exposes this as a native datetime, not a string — stored
        # as-is, it JSON-serializes fine going through the DB round trip
        # (json.dumps there would already fail loudly), but crashes the API
        # response for whichever trip is still in-progress in memory,
        # because that one skips the DB and gets json.dumps()'d directly.
        if isinstance(gps_ts_raw, datetime):
            gps_ts = gps_ts_raw.isoformat()
        elif gps_ts_raw is not None:
            gps_ts = str(gps_ts_raw)
        else:
            gps_ts = None
        return lat, lon, heading, gps_ts

    # ── Trip detection ────────────────────────────────────────────────────────

    @callback
    def _handle_odometer_change(self, event) -> None:
        new_odo = _odometer_km(event.data.get("new_state"))
        if new_odo is None:
            return
        prev_odo = self._last_odometer
        if prev_odo is not None and new_odo < prev_odo - 0.05:
            # Odometers don't run backwards; keep the baseline we trust.
            _LOGGER.debug("Mercedes Trips: ignoring odometer going back %.1f → %.1f", prev_odo, new_odo)
            return
        self._last_odometer = new_odo

        self.hass.async_create_task(self._process_odometer_change(new_odo, prev_odo))

    async def _process_odometer_change(self, new_odo: float, prev_odo: float | None) -> None:
        async with self._lock:
            now_iso = dt_util.now().isoformat()

            if self._active_trip is None:
                # The first reading after HA starts, or after the car comes
                # back from unavailable, is only a baseline — not a trip.
                if prev_odo is None or new_odo <= prev_odo + 0.05:
                    return
                # Start from the reading before the movement, so the
                # distance up to the first update isn't lost.
                await self._start_trip(prev_odo, new_odo, now_iso)
                return

            stable_odo = self._active_trip.get("stable_odometer", self._active_trip["start_odometer"])
            if new_odo > stable_odo + 0.05:
                self._active_trip["stable_odometer"] = new_odo
                self._active_trip["last_movement"] = now_iso
                await self._store.async_save(self._active_trip)
                _LOGGER.debug("Mercedes Trips: movement detected, odo=%.1f km", new_odo)

    async def _start_trip(self, odometer: float, current_odometer: float, now_iso: str) -> None:
        gps = self._get_gps()
        soc = self._get_soc()

        first_waypoint = []
        if gps:
            lat, lon, heading, gps_ts = gps
            first_waypoint = [[lat, lon, gps_ts or now_iso, heading]]

        self._active_trip = {
            "start_time": now_iso,
            "start_odometer": odometer,
            "stable_odometer": current_odometer,
            "start_soc": soc,
            "start_lat": gps[0] if gps else None,
            "start_lon": gps[1] if gps else None,
            "last_movement": now_iso,
            "waypoints": first_waypoint,
        }
        await self._store.async_save(self._active_trip)
        # "Trip in progress" goes active now, not only once the trip ends.
        self._notify_sensors()
        _LOGGER.info(
            "Mercedes Trips: trip started — odo=%.1f km, SoC=%s%%",
            odometer,
            soc,
        )

    async def _periodic_waypoint(self, _now=None) -> None:
        if self._active_trip is None:
            return
        async with self._lock:
            # Checked again: the trip may have closed while waiting for the lock.
            if self._active_trip is None:
                return
            gps = self._get_gps()
            if gps is None:
                return
            lat, lon, heading, gps_ts = gps
            waypoints = self._active_trip.get("waypoints", [])
            if waypoints:
                last_lat, last_lon = waypoints[-1][0], waypoints[-1][1]
                if _haversine_km(last_lat, last_lon, lat, lon) < 0.02:
                    return  # Not moved enough to record a new waypoint
            ts = gps_ts or dt_util.now().isoformat()
            waypoints.append([lat, lon, ts, heading])
            self._active_trip["waypoints"] = waypoints
            await self._store.async_save(self._active_trip)

    async def _periodic_inactivity_check(self, _now=None) -> None:
        if self._active_trip is None:
            return
        async with self._lock:
            if self._active_trip is None:  # closed while waiting for the lock
                return
            timeout_min = self._config.get(CONF_INACTIVITY_TIMEOUT, 8)
            last_movement = self._active_trip.get("last_movement")
            if last_movement is None:
                return

            try:
                last_dt = datetime.fromisoformat(last_movement)
                if last_dt.tzinfo is None:
                    last_dt = last_dt.replace(tzinfo=timezone.utc)
            except ValueError:
                return

            now = dt_util.now()
            inactive_min = (now - last_dt).total_seconds() / 60

            if inactive_min >= timeout_min:
                await self._close_trip()

    async def _check_stale_trip(self) -> None:
        """Discard recovered trips that are too old (> 2 hours without movement)."""
        if self._active_trip is None:
            return
        last_movement = self._active_trip.get("last_movement")
        if last_movement is None:
            self._active_trip = None
            await self._store.async_save(None)
            return

        try:
            last_dt = datetime.fromisoformat(last_movement)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            self._active_trip = None
            await self._store.async_save(None)
            return

        if (dt_util.now() - last_dt).total_seconds() > 7200:
            _LOGGER.info("Mercedes Trips: discarding stale recovered trip (>2h inactive)")
            self._active_trip = None
            await self._store.async_save(None)

    async def _close_trip(self) -> None:
        trip = self._active_trip
        if trip is None:
            return

        end_odo = self._get_odometer()
        end_soc = self._get_soc()
        gps = self._get_gps()
        now_iso = dt_util.now().isoformat()

        start_odo = trip.get("start_odometer")
        distance_km = None
        if end_odo is not None and start_odo is not None:
            distance_km = round(end_odo - start_odo, 2)

        min_dist = self._config.get(CONF_MIN_TRIP_DISTANCE, 0.5)
        if distance_km is not None and distance_km < min_dist:
            _LOGGER.info(
                "Mercedes Trips: discarding trip (%.2f km < %.1f km minimum)",
                distance_km, min_dist,
            )
            self._active_trip = None
            await self._store.async_save(None)
            self._notify_sensors()
            return

        start_soc = trip.get("start_soc")
        soc_used = None
        kwh_used = None
        avg_kwh = None
        battery_kwh = _safe_float(self._config.get(CONF_BATTERY_CAPACITY))

        if start_soc is not None and end_soc is not None and battery_kwh:
            soc_used = round(start_soc - end_soc, 1)
            if soc_used > 0:
                kwh_used = round(soc_used / 100 * battery_kwh, 2)
                if distance_km and distance_km > 0:
                    avg_kwh = round(kwh_used / distance_km * 100, 1)

        end_lat = gps[0] if gps else None
        end_lon = gps[1] if gps else None
        end_heading = gps[2] if gps else None
        end_gps_ts = gps[3] if gps else None

        start_address = ""
        end_address = ""
        if trip.get("start_lat") is not None:
            start_address = await self._geocode(trip["start_lat"], trip["start_lon"])
        if end_lat is not None:
            end_address = await self._geocode(end_lat, end_lon)

        # Add final waypoint
        waypoints = trip.get("waypoints", [])
        if gps and (not waypoints or _haversine_km(waypoints[-1][0], waypoints[-1][1], end_lat, end_lon) > 0.02):
            waypoints.append([end_lat, end_lon, end_gps_ts or now_iso, end_heading])

        completed = {
            "start_time": trip["start_time"],
            "end_time": now_iso,
            "start_odometer": start_odo,
            "end_odometer": end_odo,
            "distance_km": distance_km,
            "start_soc": start_soc,
            "end_soc": end_soc,
            "soc_used": soc_used,
            "kwh_used": kwh_used,
            "avg_kwh_per_100km": avg_kwh,
            "waypoints": waypoints,
            "start_lat": trip.get("start_lat"),
            "start_lon": trip.get("start_lon"),
            "start_address": start_address,
            "end_lat": end_lat,
            "end_lon": end_lon,
            "end_address": end_address,
        }

        trip_id = await self.hass.async_add_executor_job(self._insert_trip, completed)

        self._active_trip = None
        await self._store.async_save(None)

        _LOGGER.info(
            "Mercedes Trips: trip saved (id=%d) — %.1f km, %.1f kWh, %s → %s",
            trip_id,
            distance_km or 0,
            kwh_used or 0,
            start_address or "?",
            end_address or "?",
        )

        await self._refresh_cache()
        self._notify_sensors()

    @property
    def active_trip(self) -> dict | None:
        return self._active_trip
