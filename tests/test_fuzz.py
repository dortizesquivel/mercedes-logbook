"""Property-based tests: random and hostile input where data comes in from outside.

- entity states from mbapi2020 (the odometer and numbers in general);
- the trips API's query parameters, which any Home Assistant user can send;
- the filter values that reach SQLite.
"""

from __future__ import annotations

import asyncio
import math
import sqlite3
from types import SimpleNamespace
from urllib.parse import urlencode

from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from homeassistant.helpers.http import KEY_HASS
from hypothesis import HealthCheck, given, settings, strategies as st
import pytest

from custom_components.mercedes_trips import http_views
from custom_components.mercedes_trips.const import DOMAIN
from custom_components.mercedes_trips.coordinator import TripCoordinator, _odometer_km, _safe_float

from .common import make_trip

FUZZ = settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])

anything = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(),
    st.floats(allow_nan=True, allow_infinity=True),
    st.text(),
    st.binary(),
    st.lists(st.integers(), max_size=3),
    st.dictionaries(st.text(max_size=3), st.integers(), max_size=2),
)

# Text that looks like what the parameters expect, mixed with what an attacker would try.
param_text = st.one_of(
    st.text(max_size=40),
    st.from_regex(r"-?[0-9]{1,25}", fullmatch=True),
    st.from_regex(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", fullmatch=True),
    st.dates().map(str),
    st.sampled_from(["' OR 1=1 --", "'; DROP TABLE trips; --", "1; DELETE FROM trips", "%", "_", "\x00"]),
    st.just("\uff11\uff12"),  # full-width digits, which int() accepts
)


@given(anything)
def test_safe_float_is_finite_or_the_default(value):
    result = _safe_float(value)
    assert result is None or (isinstance(result, float) and math.isfinite(result))


@given(
    state=st.one_of(param_text, st.floats().map(str), st.sampled_from(["unknown", "unavailable"])),
    unit=st.sampled_from(["km", "mi", None, "", "m"]),
)
def test_odometer_reading_is_positive_finite_or_none(state, unit):
    result = _odometer_km(SimpleNamespace(state=state, attributes={"unit_of_measurement": unit}))
    assert result is None or (math.isfinite(result) and result > 0)


@given(st.dictionaries(st.sampled_from(["start_date", "end_date", "hour_start", "hour_end"]), param_text))
def test_filters_are_valid_or_rejected(query):
    try:
        start_date, end_date, hour_start, hour_end = http_views._filters(query)
    except ValueError as exc:
        assert str(exc).split()[0] in query  # the message names the parameter
        return
    for value in (start_date, end_date):
        assert value is None or http_views._DATE_RE.fullmatch(value)
    for value in (hour_start, hour_end):
        assert value is None or 0 <= value <= 23


@pytest.fixture(scope="module")
def coordinator(tmp_path_factory):
    """A coordinator over a real database file, without Home Assistant: the queries are plain sqlite3."""
    coordinator = TripCoordinator.__new__(TripCoordinator)
    coordinator._db_path = str(tmp_path_factory.mktemp("fuzz") / "mercedes_trips.db")
    coordinator._active_trip = None
    coordinator._init_db()
    for start in ("2026-10-04T08:10:00+02:00", "2026-10-05T23:30:00+02:00", "2026-10-06T00:15:00+01:00"):
        coordinator._insert_trip(make_trip(start))
    return coordinator


def count(coordinator) -> int:
    conn = sqlite3.connect(coordinator._db_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
    finally:
        conn.close()


@FUZZ
@given(
    start_date=st.one_of(st.none(), param_text),
    end_date=st.one_of(st.none(), param_text),
    hour_start=st.one_of(st.none(), st.integers(0, 23)),
    hour_end=st.one_of(st.none(), st.integers(0, 23)),
    limit=st.integers(1, http_views.MAX_LIMIT),
    offset=st.integers(0, http_views.MAX_OFFSET),
)
def test_filter_values_are_data_not_sql(coordinator, start_date, end_date, hour_start, hour_end, limit, offset):
    """Whatever the values, the query treats them as values: the result is what comparing the
    stored text gives, and nothing in the database changes."""
    trips = coordinator.get_trips(limit, offset, start_date, end_date, hour_start, hour_end)
    totals = coordinator.get_trip_totals(start_date, end_date, hour_start, hour_end)

    def keep(start: str) -> bool:
        hour = int(start[11:13])
        return (
            (not start_date or start >= start_date)
            and (not end_date or start <= end_date + "T23:59:59")
            and (hour_start is None or hour >= hour_start)
            and (hour_end is None or hour <= hour_end)
        )

    every = sorted(
        (t["start_time"] for t in coordinator.get_trips(1000, 0)),
        reverse=True,
    )
    expected = [s for s in every if keep(s)]
    assert [t["start_time"] for t in trips] == expected[offset : offset + limit]
    assert totals["trip_count"] == len(expected)
    assert count(coordinator) == 3


def call_view(view_class, coordinator, path: str, **match_info) -> web.Response:
    """Run a view's handler the way aiohttp would, without a server."""
    app = web.Application()
    app[KEY_HASS] = SimpleNamespace(
        data={DOMAIN: {"entry": coordinator}},
        async_add_executor_job=lambda func, *args: asyncio.sleep(0, func(*args)),
    )
    request = make_mocked_request("GET", path, app=app, match_info=match_info)
    return asyncio.run(view_class().get(request, **match_info))


@FUZZ
@given(
    st.dictionaries(
        st.sampled_from(["start_date", "end_date", "hour_start", "hour_end", "limit", "offset", "other"]),
        param_text,
    )
)
def test_list_and_totals_answer_200_or_400(coordinator, query):
    path = "?" + urlencode(query)
    for view in (http_views.TripsListView, http_views.TripTotalsView):
        resp = call_view(view, coordinator, path)
        assert resp.status in (200, 400), (view, query, resp.status, resp.text)


@FUZZ
@given(param_text)
def test_detail_answers_200_400_or_404(coordinator, trip_id):
    resp = call_view(http_views.TripDetailView, coordinator, "/x", trip_id=trip_id)
    assert resp.status in (200, 400, 404), (trip_id, resp.status, resp.text)
