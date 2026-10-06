DOMAIN = "mercedes_trips"

CONF_ODOMETER_ENTITY = "odometer_entity"
CONF_TRACKER_ENTITY = "tracker_entity"
CONF_SOC_ENTITY = "soc_entity"
CONF_RANGE_ENTITY = "range_entity"
CONF_BATTERY_CAPACITY = "battery_capacity_kwh"
CONF_INACTIVITY_TIMEOUT = "inactivity_timeout_min"
CONF_MIN_TRIP_DISTANCE = "min_trip_distance_km"

# Integration whose entities the config flow pre-selects, and the
# unique_id/entity_id suffix it gives each one (see config_flow).
MBAPI2020_DOMAIN = "mbapi2020"

DEFAULT_INACTIVITY_TIMEOUT = 8
DEFAULT_MIN_DISTANCE = 0.5

DB_FILENAME = "mercedes_trips.db"
STORAGE_KEY = "mercedes_trips.active_trip"
STORAGE_VERSION = 1

WAYPOINT_INTERVAL_SECONDS = 30
INACTIVITY_CHECK_INTERVAL_SECONDS = 120
GEOCODE_PRECISION = 4
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
# Nominatim's usage policy asks for a UA that identifies the app, and at
# most one request per second.
NOMINATIM_USER_AGENT = "mercedes-trips-ha (+https://github.com/dortizesquivel/mercedes-logbook)"
NOMINATIM_MIN_INTERVAL_SECONDS = 1.1
