DOMAIN = "mercedes_trips"

CONF_ODOMETER_ENTITY = "odometer_entity"
CONF_TRACKER_ENTITY = "tracker_entity"
CONF_SOC_ENTITY = "soc_entity"
CONF_RANGE_ENTITY = "range_entity"
CONF_BATTERY_CAPACITY = "battery_capacity_kwh"
CONF_INACTIVITY_TIMEOUT = "inactivity_timeout_min"
CONF_MIN_TRIP_DISTANCE = "min_trip_distance_km"

DEFAULT_ODOMETER_ENTITY = "sensor.eqb_300_odometer"
DEFAULT_TRACKER_ENTITY = "device_tracker.eqb_300_device_tracker"
DEFAULT_SOC_ENTITY = "sensor.eqb_300_state_of_charge"
DEFAULT_RANGE_ENTITY = "sensor.eqb_300_range_electric"
DEFAULT_BATTERY_CAPACITY = 66.5
DEFAULT_INACTIVITY_TIMEOUT = 8
DEFAULT_MIN_DISTANCE = 0.5

DB_FILENAME = "mercedes_trips.db"
STORAGE_KEY = "mercedes_trips.active_trip"
STORAGE_VERSION = 1

WAYPOINT_INTERVAL_SECONDS = 30
INACTIVITY_CHECK_INTERVAL_SECONDS = 120
GEOCODE_PRECISION = 4
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
NOMINATIM_USER_AGENT = "mercedes-trips-ha/1.0"
