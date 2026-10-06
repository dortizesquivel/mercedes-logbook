/**
 * Mercedes Trips Card — Custom Lovelace card
 * Multi-trip Leaflet map, quick period filters, and stats for the selected
 * period compared with the one right before it. UI in English or Spanish,
 * following the Home Assistant user's language.
 */

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS  = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
// Display face only (title + readout figures); everything else uses the
// HA theme's own font so the card sits naturally on the dashboard.
const BRAND_FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&display=swap";

// Four colors, not ten — enough to tell recent trips apart on the map and
// in the list without turning either into a rainbow.
const ROUTE_COLORS = ["#00c2b2", "#ffb020", "#9a8cf0", "#ff6b5e"];

// Cap rendered waypoints per trip so long trips (hours of GPS points every
// 30s) don't stall the main thread when drawing/fitting the map.
const MAX_TRIP_POINTS = 300;

// UI strings. English is the fallback for every language without its own
// table; {name} placeholders are filled by _t().
const STRINGS = {
  en: {
    title: "Trip logbook",
    "filter.today": "Today", "filter.yesterday": "Yesterday", "filter.7d": "7 days",
    "filter.month": "This month", "filter.lastMonth": "Last month", "filter.year": "This year",
    "filter.custom": "Custom", "filter.group": "Period",
    from: "From", to: "To", hours: "Hours", apply: "Apply", backTo: "Back to {label}",
    driving: "Driving",
    distance: "Distance", trips: "Trips", energy: "Energy", avgConsumption: "Avg. consumption",
    newValue: "New",
    vsPrevDay: "Compared with the previous day", vsPrevDays: "Compared with the previous {days} days",
    allHistory: "All history", hourRange: ", {from}:00 to {to}:00",
    today: "Today", yesterday: "Yesterday", unknownPlace: "Unknown location",
    emptyTitle: "No trips in this period", emptyBody: "Try a wider period.", show: "Show {label}",
    departure: "From", arrival: "To", duration: "Duration", consumption: "Consumption",
    batteryUsed: "Battery used", odometer: "Odometer",
    cardDescription: "Trip map with quick period filters and period-over-period stats",
  },
  es: {
    title: "Cuaderno de ruta",
    "filter.today": "Hoy", "filter.yesterday": "Ayer", "filter.7d": "7 días",
    "filter.month": "Este mes", "filter.lastMonth": "Mes anterior", "filter.year": "Este año",
    "filter.custom": "Personalizado", "filter.group": "Periodo",
    from: "Desde", to: "Hasta", hours: "Horas", apply: "Aplicar", backTo: "Volver a {label}",
    driving: "En ruta",
    distance: "Distancia", trips: "Trayectos", energy: "Energía", avgConsumption: "Consumo medio",
    newValue: "Nuevo",
    vsPrevDay: "Comparado con el día anterior", vsPrevDays: "Comparado con los {days} días anteriores",
    allHistory: "Todo el historial", hourRange: ", de {from}:00 a {to}:00",
    today: "Hoy", yesterday: "Ayer", unknownPlace: "Ubicación desconocida",
    emptyTitle: "No hay trayectos en estas fechas", emptyBody: "Prueba con un periodo más amplio.", show: "Ver {label}",
    departure: "Salida", arrival: "Llegada", duration: "Duración", consumption: "Consumo",
    batteryUsed: "Batería usada", odometer: "Odómetro",
    cardDescription: "Mapa de trayectos con filtros rápidos y estadísticas comparativas",
  },
};

// Set from hass.locale on every hass update (see _applyLocale). Module
// level because the formatting helpers below are plain functions; every
// card on a dashboard shares the same user and so the same language.
let _locale = "en";
let _strings = STRINGS.en;
_setLanguage(document.documentElement.lang || navigator.language);
let _hour12; // undefined → whatever the locale uses

function _t(key, vars = {}) {
  const s = _strings[key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function _setLanguage(lang) {
  try {
    // An unknown tag would make every toLocaleString() call throw.
    _locale = Intl.DateTimeFormat.supportedLocalesOf(lang || "en")[0] || "en";
  } catch (_) {
    _locale = "en";
  }
  _strings = STRINGS[_locale.split("-")[0].toLowerCase()] || STRINGS.en;
}

// HA's own profile settings: language, plus the 12/24 h choice, which
// can differ from what the language would default to.
function _applyLocale(hass) {
  _setLanguage(hass?.locale?.language || hass?.language || navigator.language);
  const tf = hass?.locale?.time_format;
  _hour12 = tf === "12" ? true : tf === "24" ? false : undefined;
}

const QUICK_FILTERS = ["today", "yesterday", "7d", "month", "lastMonth", "year"];
function _quickLabel(key) { return _t(`filter.${key}`); }
const DEFAULT_QUICK_FILTER = "7d";

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function _loadStylesheet(href) {
  return new Promise((resolve) => {
    if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href;
    l.onload = resolve; l.onerror = resolve; // fonts are cosmetic — never block on them
    document.head.appendChild(l);
  });
}

function _formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(_locale, { day: "2-digit", month: "2-digit", year: "numeric" });
}
function _formatTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(_locale, { hour: "2-digit", minute: "2-digit", hour12: _hour12 });
}
function _formatDuration(start, end) {
  if (!start || !end) return "—";
  const m = Math.round((new Date(end) - new Date(start)) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}min`;
}
function _fmtNum(v, decimals = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString(_locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
// Distances: whole km stay whole ("3 km", "319 km"), only real fractions
// get a decimal ("35.2 km") — no "3.0" noise in every row.
function _fmtKm(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString(_locale, { maximumFractionDigits: 1 });
}
function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Addresses are stored as "road, [number,] [suburb,] town" (see the
// coordinator's reverse geocoding). The list only has room for the street;
// the town is kept separately so it can be shown when it isn't the usual one.
function _splitAddress(addr) {
  const parts = (addr || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { street: _t("unknownPlace"), town: "" };
  let street = parts[0];
  if (parts[1] && /^\d+\s*[a-zA-Z]?$/.test(parts[1])) street += ` ${parts[1]}`;
  return { street, town: parts.length > 1 ? parts[parts.length - 1] : "" };
}
function _capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function _dayLabel(dayISO) {
  const now = new Date();
  const d = new Date(`${dayISO}T00:00:00`);
  const date = d.toLocaleDateString(_locale, {
    day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  if (dayISO === _isoDate(now)) return `${_t("today")}, ${date}`;
  if (dayISO === _isoDate(_addDays(now, -1))) return `${_t("yesterday")}, ${date}`;
  return `${_capitalize(d.toLocaleDateString(_locale, { weekday: "long" }))}, ${date}`;
}
function _formatRange(startISO, endISO) {
  const s = new Date(`${startISO}T00:00:00`);
  const e = new Date(`${endISO}T00:00:00`);
  const thisYear = new Date().getFullYear();
  const fmt = (d, withYear) => d.toLocaleDateString(_locale, {
    day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}),
  });
  if (startISO === endISO) return fmt(s, s.getFullYear() !== thisYear);
  const crossYear = s.getFullYear() !== e.getFullYear();
  return `${fmt(s, crossYear)} – ${fmt(e, crossYear || e.getFullYear() !== thisYear)}`;
}
function _pad2(n) { return String(n).padStart(2, "0"); }
function _isoDate(d) { return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`; }
function _addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function _quickRange(key) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (key) {
    case "today":     return { start: today, end: today };
    case "yesterday": { const y = _addDays(today, -1); return { start: y, end: y }; }
    case "7d":        return { start: _addDays(today, -6), end: today };
    case "month":     return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: today };
    case "lastMonth": {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      return { start, end };
    }
    case "year":      return { start: new Date(today.getFullYear(), 0, 1), end: today };
    default:          return null;
  }
}

// Same-length window immediately preceding [startISO, endISO] — used for
// the "vs. previous period" delta on any range, including custom ones.
function _previousRange(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  const days = Math.round((end - start) / 86400000) + 1;
  const prevEnd = _addDays(start, -1);
  const prevStart = _addDays(prevEnd, -(days - 1));
  return { start: prevStart, end: prevEnd };
}

class MercedesTripsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._trips = [];
    this._activeTrip = null;
    this._prevTotals = null;
    this._map = null;
    this._mapLayers = [];
    this._selectedTrip = null;
    this._quickFilter = DEFAULT_QUICK_FILTER;
    this._filters = { startDate: "", endDate: "", hourStart: 0, hourEnd: 23 };
    this._haToken = null;
    this._rendered = false;
    this._fetchSeq = 0;
  }

  setConfig(config) {
    this._config = config || {};
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._haToken) {
      this._haToken = hass.auth?.data?.access_token || null;
    }
    _applyLocale(hass);
    if (!this._rendered) {
      this._rendered = true;
      this._init();
    }
    this._applyTheme();
  }

  // Cheap enough to run on every hass update: follows HA's light/dark
  // switch live without a re-render.
  _applyTheme() {
    const card = this.shadowRoot.querySelector(".card");
    if (card) card.classList.toggle("dark", !!this._hass?.themes?.darkMode);
  }

  async _init() {
    // Build DOM first (Leaflet CSS loads inside shadow root via <link>)
    this._buildDOM();
    // Default to "este mes" so the card opens scoped, not dumping the
    // whole history — quick filters exist precisely to avoid that.
    const range = _quickRange(DEFAULT_QUICK_FILTER);
    this._filters.startDate = _isoDate(range.start);
    this._filters.endDate = _isoDate(range.end);
    this._syncFilterControls();
    // Then load Leaflet JS + brand fonts (fonts never block card init)
    _loadStylesheet(BRAND_FONTS_CSS);
    await _loadScript(LEAFLET_JS);
    // Other HA cards (e.g. vehicle-info-card) bundle their own Leaflet copy
    // and reassign window.L for their own use once they load. Snapshot our
    // own reference right now so later reassignment elsewhere on the
    // dashboard can't make us mix objects from two different Leaflet
    // instances (that mismatch corrupts internal map state and throws
    // "Cannot read properties of undefined (reading 'x')" inside Leaflet).
    this._L = window.L;
    // Init map and fetch data
    this._scheduleMapInit();
    await this._fetchAndDraw();
  }

  _buildDOM() {
    // The <link> for Leaflet CSS is placed INSIDE the shadow root so that
    // all Leaflet tile/pane positioning rules apply within this shadow tree.
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="${LEAFLET_CSS}">
      <style>
        :host {
          display: block;
          /* Every color token below resolves to a Home Assistant theme
             variable first — the card follows whatever theme (and
             light/dark mode) the user has active. The hex after the comma
             is only a fallback for the rare theme that doesn't define it,
             never the real value. */
          --accent: var(--primary-color, #03a9f4);
          --accent-on: var(--text-primary-color, #fff);
          --good: var(--success-color, #4caf50);
          --bad: var(--error-color, #db4437);
          --font-display: 'Chakra Petch', var(--primary-font-family, sans-serif);
        }
        .card {
          background: var(--card-background-color, #1c1c1e);
          border-radius: 12px;
          overflow: hidden;
          font-family: var(--primary-font-family, sans-serif);
          color: var(--primary-text-color, #fff);
          /* Dashboards put this card in narrow "sections" columns while the
             browser viewport stays desktop-wide — a @media breakpoint never
             fires in that case. Respond to the card's own rendered width
             instead so the instrument strip actually collapses when it's
             squeezed, rather than overflowing its rounded corners. */
          container-type: inline-size;
          container-name: mt-card;
        }

        /* ── Header ──────────────────────────────────────────────────── */
        .card-header {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; padding: 18px 20px 14px;
        }
        .card-title {
          font-family: var(--font-display); font-weight: 700; font-size: 1.3rem;
          letter-spacing: .01em; margin: 0; text-wrap: balance;
        }
        .badge-live {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 0.75rem; font-weight: 600;
          color: var(--accent-on); background: var(--accent);
          padding: 4px 10px 4px 8px; border-radius: 100px; white-space: nowrap;
        }
        .badge-live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-on); animation: mt-pulse 1.8s ease-in-out infinite; }
        @keyframes mt-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

        /* ── Instrument strip: the trip-computer readout ────────────────
           Tinted with the theme's own accent over the theme's own card
           surface, so it reads as a distinct "readout" panel in any
           theme (light or dark) instead of forcing one look. */
        .instrument {
          margin: 0 20px 16px;
          background: color-mix(in srgb, var(--accent) 10%, var(--card-background-color, #1c1c1e));
          border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
          border-radius: 12px; padding: 14px 4px 12px;
          display: grid; grid-template-columns: repeat(4, 1fr);
        }
        .instrument .stat {
          padding: 0 12px; border-left: 1px solid var(--divider-color, rgba(127,127,127,.2));
          display: flex; flex-direction: column; gap: 2px;
          /* Grid items default to min-width:auto, which refuses to shrink
             below the content's natural (unwrapped) width — that's what
             was pushing the delta text past the panel's rounded corners
             when the card renders narrower than the text needs. */
          min-width: 0;
        }
        .instrument .stat:first-child { padding-left: 4px; border-left: none; }
        .instrument .stat:nth-child(4) { padding-right: 4px; }
        .stat-value {
          font-family: var(--font-display); font-variant-numeric: tabular-nums;
          font-weight: 700; font-size: clamp(1.05rem, 2.6vw, 1.4rem); line-height: 1.15;
          color: var(--primary-text-color, #fff);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .stat-value .unit { font-family: var(--primary-font-family, sans-serif); font-size: 0.56em; font-weight: 500; color: var(--accent); margin-left: 3px; }
        .stat-label { font-size: 0.75rem; color: var(--secondary-text-color, #aaa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .stat-delta { font-size: 0.72rem; font-weight: 600; font-variant-numeric: tabular-nums; min-height: 1.3em; line-height: 1.3; white-space: nowrap; }
        .stat-delta.neutral { color: var(--secondary-text-color, #aaa); }
        .stat-delta.good { color: var(--good); }
        .stat-delta.bad { color: var(--bad); }
        /* One line naming what every delta above is compared against,
           instead of repeating "vs. anterior" under each figure. */
        .instrument-caption { grid-column: 1 / -1; margin: 10px 4px 0; font-size: 0.72rem; color: var(--secondary-text-color, #aaa); }
        .instrument.is-loading .stat-value, .instrument.is-loading .stat-label,
        .instrument.is-loading .stat-delta, .instrument.is-loading .instrument-caption { visibility: hidden; }

        /* ── Quick filters ───────────────────────────────────────────────
           One row that scrolls sideways on a phone instead of wrapping
           into two ragged lines; the chips run to the card edge so the
           cut-off chip signals there's more. */
        .filter-block { padding-bottom: 14px; }
        .quick-filters {
          display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none;
          padding: 2px 20px; scroll-padding-inline: 20px;
        }
        .quick-filters::-webkit-scrollbar { display: none; }
        .chip {
          flex: none; font: inherit; font-size: 0.8rem; font-weight: 500;
          background: rgba(127,127,127,0.12); border: 1px solid transparent;
          color: var(--secondary-text-color, #aaa); border-radius: 100px;
          padding: 7px 13px; cursor: pointer;
        }
        .chip:hover { color: var(--primary-text-color, #fff); }
        .chip.is-active { background: var(--accent); color: var(--accent-on); }
        .chip-custom { display: inline-flex; align-items: center; gap: 5px; }
        .chip-custom .caret { font-size: 0.65em; transition: transform .15s; }
        .chip-custom[aria-expanded="true"] .caret { transform: rotate(180deg); }
        .chip:focus-visible, .btn:focus-visible, .filter-clear:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 2px;
        }

        .custom-range { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 20px 0; padding-top: 12px; border-top: 1px dashed var(--divider-color, rgba(255,255,255,0.12)); }
        .field { display: flex; align-items: center; gap: 6px; background: rgba(127,127,127,0.1); border: 1px solid transparent; border-radius: 100px; padding: 5px 12px; }
        .field label { font-size: 0.75rem; color: var(--secondary-text-color, #aaa); }
        .field input, .field select { border: none; background: transparent; color: inherit; font: inherit; font-size: 0.8rem; outline: none; }
        .field select { cursor: pointer; }
        .field .sep { color: var(--secondary-text-color, #aaa); font-size: 0.76rem; }
        .field:focus-within { border-color: var(--accent); }

        .btn {
          font: inherit; font-size: 0.8rem; font-weight: 600; border: none;
          border-radius: 100px; padding: 8px 16px; cursor: pointer;
        }
        .btn-primary { background: var(--accent); color: var(--accent-on); }
        .btn-primary:hover { filter: brightness(1.1); }

        .filter-summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 12px 20px 0; font-size: 0.8rem; color: var(--secondary-text-color, #aaa); }
        .filter-clear {
          font: inherit; font-size: 0.78rem; background: none; border: none;
          color: var(--accent); cursor: pointer; padding: 2px; white-space: nowrap;
        }
        .filter-clear:hover { text-decoration: underline; text-underline-offset: 2px; }
        .filter-clear[hidden] { display: none; }

        /* ── Map container ─────────────────────────────────────────────
           Position MUST be relative so Leaflet's absolute children are
           clipped. No z-index here so we don't create an unwanted
           stacking context that fights the card flow. */
        #map-container {
          width: calc(100% - 40px);
          height: 340px;
          margin: 4px 20px 18px;
          border-radius: 12px;
          position: relative;
          overflow: hidden;
        }
        #map { width: 100%; height: 100%; }
        /* OSM only serves light tiles. In a dark HA theme, invert just the
           tile pane — routes and markers live in other panes and keep
           their real colors — so the map doesn't glare out of the card. */
        .card.dark .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(.95) contrast(.85) saturate(.4); }

        /* ── Full Leaflet CSS inlined — CDN link is a bonus; these rules
           are the authoritative source so HA's CSP cannot block them. ── */
        .leaflet-container {
          position: relative !important; overflow: hidden !important;
          background: var(--secondary-background-color, #ddd); outline: 0; cursor: grab; -webkit-tap-highlight-color: transparent;
        }
        .leaflet-container:focus { outline: none; }
        .leaflet-container a { color: var(--accent); }
        .leaflet-container a.leaflet-active { outline: 2px solid orange; }

        .leaflet-map-pane, .leaflet-tile, .leaflet-marker-icon, .leaflet-marker-shadow,
        .leaflet-tile-pane, .leaflet-overlay-pane, .leaflet-shadow-pane, .leaflet-marker-pane,
        .leaflet-popup-pane, .leaflet-map-pane canvas, .leaflet-map-pane svg { position: absolute; }

        .leaflet-map-pane { z-index: 2; top: 0; left: 0; }
        .leaflet-tile-pane    { z-index: 2; }
        .leaflet-overlay-pane { z-index: 4; }
        .leaflet-shadow-pane  { z-index: 5; }
        .leaflet-marker-pane  { z-index: 6; }
        .leaflet-tooltip-pane { z-index: 6; }
        .leaflet-popup-pane   { z-index: 7; }

        .leaflet-pane { position: absolute; top: 0; left: 0; }
        .leaflet-pane > svg, .leaflet-pane > canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }

        .leaflet-tile-container { pointer-events: none; }
        .leaflet-tile { position: absolute; image-rendering: auto; }
        .leaflet-zoom-box { width: 0; height: 0; box-sizing: border-box; z-index: 800; }

        .leaflet-control { position: relative; z-index: 800; pointer-events: auto; float: left; clear: both; }
        .leaflet-bottom .leaflet-control { margin-bottom: 5px; }
        .leaflet-top    .leaflet-control { margin-top: 5px; }
        .leaflet-left   .leaflet-control { margin-left: 10px; }
        .leaflet-right  .leaflet-control { margin-right: 10px; }

        .leaflet-bottom, .leaflet-top { position: absolute; z-index: 1000; pointer-events: none; }
        .leaflet-top    { top: 0; }
        .leaflet-bottom { bottom: 0; }
        .leaflet-left   { left: 0; }
        .leaflet-right  { right: 0; }

        .leaflet-control-zoom { border: 1px solid var(--divider-color, rgba(0,0,0,0.2)); border-radius: 8px; overflow: hidden; }
        .leaflet-bar a, .leaflet-bar a:hover {
          background-color: var(--card-background-color, #fff); border-bottom: 1px solid var(--divider-color, #ccc);
          width: 28px; height: 28px; display: block;
          text-align: center; line-height: 28px; text-decoration: none; color: var(--primary-text-color, #000);
        }
        .leaflet-bar a:last-child { border-bottom: none; }
        .leaflet-bar a.leaflet-disabled { cursor: default; color: var(--disabled-text-color, #bbb); }

        .leaflet-zoom-animated { transition: transform 0.25s cubic-bezier(0,0,0.25,1); }
        .leaflet-pan-anim  .leaflet-tile, .leaflet-zoom-anim .leaflet-tile { transition: none; }
        .leaflet-zoom-anim .leaflet-zoom-animated { will-change: transform; }

        /* Doubled-up selector: leaflet.css (also loaded) paints this box
           white with .leaflet-container .leaflet-control-attribution. */
        .leaflet-container .leaflet-control-attribution, .leaflet-control-scale-line {
          padding: 0 6px; background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent);
          color: var(--secondary-text-color, #555); border-top-left-radius: 6px;
          font-size: 11px; white-space: nowrap; overflow: hidden;
        }
        .leaflet-control-attribution a { text-decoration: none; }
        .leaflet-control-attribution a:hover { text-decoration: underline; }

        .leaflet-tooltip {
          position: absolute; background: #fff; border: 1px solid #fff;
          border-radius: 3px; padding: 6px; white-space: nowrap;
          color: #333; font-size: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.4);
          pointer-events: none; z-index: 900;
        }
        .leaflet-fade-anim .leaflet-popup { opacity: 0; transition: opacity 0.2s linear; }
        .leaflet-fade-anim .leaflet-map-pane .leaflet-popup { opacity: 1; }

        /* ── Logbook: trips grouped by day ──────────────────────────────
           Each trip is a two-stop itinerary. Its rail is the same color
           as its line on the map (start filled, end hollow), so a row
           and its route read as one thing. */
        .trip-list {
          position: relative; /* offsetParent for keeping the open trip in view */
          max-height: 380px; overflow-y: auto; overscroll-behavior: contain;
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.08));
        }
        .day-head {
          position: sticky; top: 0; z-index: 1;
          display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
          padding: 12px 20px 6px;
          background: var(--card-background-color, #1c1c1e);
          font-size: 0.78rem; font-weight: 600; color: var(--secondary-text-color, #aaa);
        }
        .day-head .day-km { font-weight: 500; font-variant-numeric: tabular-nums; }
        .trip {
          display: grid; grid-template-columns: 12px auto minmax(0, 1fr) auto;
          column-gap: 12px; row-gap: 4px; align-items: center;
          width: 100%; margin: 0; padding: 8px 20px; border: none; background: none;
          color: inherit; font: inherit; font-size: 0.86rem; line-height: 1.3;
          text-align: left; cursor: pointer;
        }
        .trip:hover { background: rgba(127,127,127,0.08); }
        .trip[aria-expanded="true"] { background: rgba(127,127,127,0.12); }
        .trip:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
        /* Mirrors the map dimming: once something's selected, everything
           else steps back so the pair (row + route) reads as one unit. */
        .trip-list.has-selection .trip:not([aria-expanded="true"]) { opacity: .45; }
        .trip-list.has-selection .trip:not([aria-expanded="true"]):hover { opacity: .75; }

        .rail { grid-row: 1 / 3; align-self: stretch; position: relative; }
        .rail::before {
          /* Stops at the end dot's edge so the hollow dot stays hollow
             over any row background (hover, selected). */
          content: ""; position: absolute; left: 50%; top: .65em; bottom: calc(.65em + 4.5px);
          width: 2px; transform: translateX(-50%); background: var(--route-color); opacity: .4;
        }
        .rail i {
          position: absolute; left: 50%; width: 9px; height: 9px; border-radius: 50%;
          box-sizing: border-box; transform: translate(-50%, -50%);
        }
        .rail .from { top: .65em; background: var(--route-color); }
        .rail .to { top: calc(100% - .65em); border: 2px solid var(--route-color); }
        .trip .time { font-size: 0.8rem; font-variant-numeric: tabular-nums; color: var(--secondary-text-color, #aaa); }
        .trip .place { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .trip .place .town { color: var(--secondary-text-color, #aaa); }
        .trip .val { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .trip .val.energy { font-size: 0.8rem; color: var(--secondary-text-color, #aaa); }

        /* Expanded trip — opens right under its row, not at the bottom of
           a list that may be scrolled out of sight. Indented to line up
           with the time column. */
        .trip-detail { padding: 2px 20px 14px 44px; background: rgba(127,127,127,0.12); font-size: 0.8rem; }
        .trip-detail .where { margin: 0 0 12px; color: var(--secondary-text-color, #aaa); line-height: 1.45; }
        .trip-detail .where span { color: var(--primary-text-color, #fff); }
        .trip-detail dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px 12px; margin: 0; }
        .trip-detail dt { font-size: 0.72rem; color: var(--secondary-text-color, #aaa); }
        .trip-detail dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }

        /* ── Empty & loading states ──────────────────────────────────── */
        .empty-state { margin: 16px 20px 20px; padding: 30px 16px; text-align: center; border: 1px dashed var(--divider-color, rgba(255,255,255,0.15)); border-radius: 12px; }
        .empty-title { font-family: var(--font-display); font-weight: 700; font-size: 1rem; margin: 0 0 6px; }
        .empty-body { font-size: 0.82rem; color: var(--secondary-text-color, #aaa); max-width: 40ch; margin: 0 auto 14px; }
        .skeleton {
          background: linear-gradient(90deg, rgba(127,127,127,0.12) 25%, rgba(127,127,127,0.24) 50%, rgba(127,127,127,0.12) 75%);
          background-size: 200% 100%; border-radius: 6px; animation: mt-shimmer 1.6s ease-in-out infinite;
        }
        @keyframes mt-shimmer { to { background-position: -200% 0; } }
        .skel-row { display: grid; grid-template-columns: 12px 1fr 48px; gap: 12px; align-items: center; padding: 10px 20px; }
        .skel-row .skeleton.dot { width: 9px; height: 9px; border-radius: 50%; }
        .skel-row .skeleton.line { height: 12px; }
        .skel-row .skeleton.line.short { width: 40%; margin-top: 6px; }

        /* Container queries react to this card's own rendered width, not
           the browser viewport — the correct signal in a dashboard where
           the same card can sit in a wide single-column view or a narrow
           "sections" grid column regardless of window size. */
        @container mt-card (max-width: 600px) {
          .instrument { grid-template-columns: repeat(2, 1fr); row-gap: 12px; }
          .instrument .stat:nth-child(3) { border-left: none; padding-left: 4px; }
          .instrument .stat:nth-child(2) { padding-right: 4px; }
          .trip-detail dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        /* Even a 2-column instrument can get tight in a very narrow
           column — drop to a single column rather than let it overflow. */
        @container mt-card (max-width: 300px) {
          .instrument { grid-template-columns: 1fr; }
          .instrument .stat { border-left: none; padding: 8px 4px 0; border-top: 1px solid var(--divider-color, rgba(127,127,127,.2)); }
          .instrument .stat:first-child { border-top: none; padding-top: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          .badge-live .dot { animation: none; }
          .skeleton { animation: none; background: rgba(127,127,127,0.18); }
          .chip-custom .caret { transition: none; }
        }
      </style>
      <div class="card">
        <div class="card-header">
          <h2 class="card-title" id="card-title"></h2>
          <span id="active-badge" class="badge-live" style="display:none"><span class="dot"></span>${_t("driving")}</span>
        </div>

        <div class="instrument" id="instrument"></div>

        <div class="filter-block">
          <div class="quick-filters" role="group" aria-label="${_t("filter.group")}">
            ${QUICK_FILTERS.map(key => `<button class="chip" data-key="${key}">${_quickLabel(key)}</button>`).join("")}
            <button class="chip chip-custom" id="chip-custom" aria-expanded="false">${_t("filter.custom")} <span class="caret">▾</span></button>
          </div>
          <div class="custom-range" id="custom-range" style="display:none">
            <div class="field"><label for="f-start">${_t("from")}</label><input type="date" id="f-start"></div>
            <div class="field"><label for="f-end">${_t("to")}</label><input type="date" id="f-end"></div>
            <div class="field">
              <label for="f-hour-start">${_t("hours")}</label>
              <select id="f-hour-start">${Array.from({length:24}, (_,h) => `<option value="${h}">${_pad2(h)}:00</option>`).join("")}</select>
              <span class="sep">–</span>
              <select id="f-hour-end">${Array.from({length:24}, (_,h) => `<option value="${h}"${h===23?" selected":""}>${_pad2(h)}:00</option>`).join("")}</select>
            </div>
            <button class="btn btn-primary" id="btn-apply-custom">${_t("apply")}</button>
          </div>
          <div class="filter-summary">
            <span id="filter-summary-text"></span>
            <button class="filter-clear" id="btn-clear-filter" hidden>${_t("backTo", { label: _quickLabel(DEFAULT_QUICK_FILTER).toLowerCase() })}</button>
          </div>
        </div>

        <div id="map-container">
          <div id="map"></div>
        </div>

        <div class="trip-list" id="trip-list"></div>
      </div>
    `;
    this.shadowRoot.getElementById("card-title").textContent = this._config.title || _t("title");
    this._applyTheme();

    this.shadowRoot.querySelectorAll(".chip[data-key]").forEach(chip => {
      chip.addEventListener("click", () => this._setQuickFilter(chip.dataset.key));
    });
    this.shadowRoot.getElementById("chip-custom").addEventListener("click", () => this._toggleCustomRange());
    this.shadowRoot.getElementById("btn-apply-custom").addEventListener("click", () => this._applyCustomRange());
    this.shadowRoot.getElementById("btn-clear-filter").addEventListener("click", () => this._clearFilter());
  }

  connectedCallback() {
    // HA sometimes re-attaches the element after navigation. Re-validate the
    // map size so tiles repaint correctly, and retry init if it never ran.
    if (this._map) {
      requestAnimationFrame(() => this._map && this._map.invalidateSize());
    } else if (this._rendered) {
      this._scheduleMapInit();
    }
  }

  _scheduleMapInit(attempt = 0) {
    // Retry until the shadow-DOM container has non-zero dimensions.
    // HA can set `hass` (triggering _init) before the element is visible,
    // so Leaflet would init on a 0×0 box and place tiles in wrong positions.
    requestAnimationFrame(() => {
      const el = this.shadowRoot && this.shadowRoot.getElementById("map");
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      if (width === 0 || height === 0) {
        if (attempt < 30) {
          setTimeout(() => this._scheduleMapInit(attempt + 1), 150);
        }
        return;
      }
      this._initMap();
    });
  }

  _initMap() {
    if (this._map) return;
    if (!this._L) return;

    const el = this.shadowRoot && this.shadowRoot.getElementById("map");
    if (!el) return;

    // Final dimension guard
    const { width, height } = el.getBoundingClientRect();
    if (width === 0 || height === 0) {
      setTimeout(() => this._scheduleMapInit(), 200);
      return;
    }

    // Until there are trips to fit, show the area around the HA home
    // location; the whole world if it isn't set.
    const home = this._hass?.config;
    const center = home && home.latitude != null && home.longitude != null
      ? [[home.latitude, home.longitude], 11] : [[20, 0], 2];
    this._map = this._L.map(el, {
      zoomControl: true,
      preferCanvas: true,
    }).setView(...center);

    // OSM's tile servers answer requests without a Referer with a 403
    // "Access blocked" tile. HA's frontend sets
    // <meta name="referrer" content="same-origin">, so tiles inherit "send
    // nothing cross-origin" — override it per tile so OSM gets our origin.
    // Single host, not {s}. subdomains: OSM deprecated those.
    this._L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>",
      maxZoom: 19,
      referrerPolicy: "strict-origin-when-cross-origin",
    }).addTo(this._map);

    this._map.invalidateSize({ animate: false });

    // Re-invalidate at several intervals to cover:
    // - HA card editor dialog open animation
    // - Lovelace panel transition
    // - Any other deferred layout change
    [100, 300, 600, 1200, 2500].forEach(ms =>
      setTimeout(() => this._map && this._map.invalidateSize({ animate: false }), ms)
    );

    // Disconnect any observers left over from a previous _initMap() call
    // (e.g. after the dblclick reset below) so they don't pile up.
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._intersectionObserver) this._intersectionObserver.disconnect();

    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(entries => {
        if (!this._map) return;
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) this._map.invalidateSize({ animate: false });
      });
      this._resizeObserver.observe(el);
    }

    // IntersectionObserver: re-validate when card enters viewport after
    // being off-screen (e.g. HA tab switch, panel slide-in animation).
    if (window.IntersectionObserver) {
      this._intersectionObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && this._map) {
            this._map.invalidateSize({ animate: false });
          }
        });
      }, { threshold: 0.1 });
      this._intersectionObserver.observe(this);
    }

    // Double-click on map container forces full re-init (emergency escape
    // hatch). Registered once per DOM build, not per _initMap() call, so it
    // doesn't stack up across re-inits.
    const container = this.shadowRoot.getElementById("map-container");
    if (container && !this._dblclickBound) {
      this._dblclickBound = true;
      container.addEventListener("dblclick", () => {
        if (this._map) {
          this._map.remove();
          this._map = null;
          this._scheduleMapInit();
        }
      });
    }

    // If data was already fetched before map was ready, draw now
    if (this._trips.length > 0) this._drawMap();
  }

  // ── Filters ──────────────────────────────────────────────────────────

  _setQuickFilter(key) {
    const range = _quickRange(key);
    if (!range) return;
    this._quickFilter = key;
    this._filters.startDate = _isoDate(range.start);
    this._filters.endDate = _isoDate(range.end);
    this._filters.hourStart = 0;
    this._filters.hourEnd = 23;
    this._syncFilterControls();
    this._fetchAndDraw();
  }

  _toggleCustomRange() {
    const panel = this.shadowRoot.getElementById("custom-range");
    const chip = this.shadowRoot.getElementById("chip-custom");
    const open = panel.style.display !== "none";
    if (open) {
      panel.style.display = "none";
      chip.setAttribute("aria-expanded", "false");
      return;
    }
    panel.style.display = "flex";
    chip.setAttribute("aria-expanded", "true");
    this.shadowRoot.getElementById("f-start").value = this._filters.startDate || "";
    this.shadowRoot.getElementById("f-end").value = this._filters.endDate || "";
    this.shadowRoot.getElementById("f-hour-start").value = String(this._filters.hourStart);
    this.shadowRoot.getElementById("f-hour-end").value = String(this._filters.hourEnd);
  }

  _applyCustomRange() {
    const start = this.shadowRoot.getElementById("f-start").value;
    const end = this.shadowRoot.getElementById("f-end").value;
    if (!start || !end) return;
    this._quickFilter = "custom";
    this._filters.startDate = start;
    this._filters.endDate = end;
    this._filters.hourStart = parseInt(this.shadowRoot.getElementById("f-hour-start").value, 10) || 0;
    this._filters.hourEnd = parseInt(this.shadowRoot.getElementById("f-hour-end").value, 10);
    if (Number.isNaN(this._filters.hourEnd)) this._filters.hourEnd = 23;
    this._syncFilterControls();
    this._fetchAndDraw();
  }

  _clearFilter() {
    this._setQuickFilter(DEFAULT_QUICK_FILTER);
  }

  _syncFilterControls() {
    this.shadowRoot.querySelectorAll(".chip[data-key]").forEach(chip => {
      const active = chip.dataset.key === this._quickFilter;
      chip.classList.toggle("is-active", active);
      if (active) chip.setAttribute("aria-pressed", "true");
      else chip.removeAttribute("aria-pressed");
    });
    // Only offered once you've moved off the default — on the default it
    // would be a button that does nothing.
    const clear = this.shadowRoot.getElementById("btn-clear-filter");
    if (clear) clear.hidden = this._quickFilter === DEFAULT_QUICK_FILTER;
    if (this._quickFilter !== "custom") {
      const panel = this.shadowRoot.getElementById("custom-range");
      const chip = this.shadowRoot.getElementById("chip-custom");
      if (panel) panel.style.display = "none";
      if (chip) chip.setAttribute("aria-expanded", "false");
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────

  async _fetchAndDraw() {
    // Overlapping requests (e.g. clicking two chips fast) are allowed on
    // purpose: the sequence number makes the latest filter win and any
    // older response — including the slower "previous period" fetch
    // below — get dropped. Skipping the new request instead would leave
    // the new chip highlighted over the old filter's data.
    const seq = ++this._fetchSeq;

    this._renderSkeleton();

    const { startDate, endDate, hourStart, hourEnd } = this._filters;
    const params = new URLSearchParams({ limit: 200 });
    if (startDate) params.set("start_date", startDate);
    if (endDate)   params.set("end_date", endDate);
    if (hourStart > 0)  params.set("hour_start", hourStart);
    if (hourEnd < 23)   params.set("hour_end", hourEnd);

    let trips = [], activeTrip = null;
    try {
      const headers = this._haToken ? { Authorization: `Bearer ${this._haToken}` } : {};
      const resp = await fetch(`/api/mercedes_trips/trips?${params}`, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      trips = data.trips || [];
      activeTrip = data.active_trip || null;
    } catch (e) {
      console.error("Mercedes Trips card: fetch error", e);
    }

    // A newer filter already superseded this one. Checked before touching
    // this._trips: a stale response landing late must not swap the data
    // out from under rows rendered for the newer filter.
    if (seq !== this._fetchSeq) return;
    this._trips = trips;
    this._activeTrip = activeTrip;

    // A selection from a previous filter that fell out of the new range
    // would otherwise leave every route/row dimmed with nothing highlighted.
    if (this._selectedTrip && !this._trips.some(t => t.id === this._selectedTrip.id)) {
      this._selectedTrip = null;
    }

    this._prevTotals = null;
    this._renderInstrument();
    this._renderFilterSummary();
    const badge = this.shadowRoot.getElementById("active-badge");
    if (badge) badge.style.display = this._activeTrip ? "inline-flex" : "none";
    // Leaflet errors (e.g. from a global L conflict with another map card
    // on the same dashboard) must not prevent the trip list from rendering.
    try {
      this._drawMap();
    } catch (e) {
      console.error("Mercedes Trips card: map render error", e);
    }
    this._renderList();

    this._fetchPreviousTotals(seq);
  }

  async _fetchPreviousTotals(seq) {
    const { startDate, endDate, hourStart, hourEnd } = this._filters;
    if (!startDate || !endDate) return;
    const prev = _previousRange(startDate, endDate);
    const params = new URLSearchParams({
      start_date: _isoDate(prev.start),
      end_date: _isoDate(prev.end),
    });
    if (hourStart > 0) params.set("hour_start", hourStart);
    if (hourEnd < 23)  params.set("hour_end", hourEnd);

    try {
      const headers = this._haToken ? { Authorization: `Bearer ${this._haToken}` } : {};
      const resp = await fetch(`/api/mercedes_trips/totals?${params}`, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const totals = await resp.json();
      if (seq !== this._fetchSeq) return; // filter changed again while this was in flight
      this._prevTotals = totals;
      this._renderInstrument();
    } catch (e) {
      console.error("Mercedes Trips card: previous-period fetch error", e);
    }
  }

  _computeCurrentTotals() {
    const distance = this._trips.reduce((s, t) => s + (t.distance_km || 0), 0);
    const kwh = this._trips.reduce((s, t) => s + (t.kwh_used || 0), 0);
    const count = this._trips.length;
    const avg = distance > 0 ? (kwh / distance) * 100 : null;
    return { distance, kwh, count, avg };
  }

  // Renders "▲ 12 %". What it's compared against is said once, in the
  // caption under the readout. `judged` marks stats where one direction
  // is objectively better (lower consumption), so the color carries
  // meaning; otherwise the delta is informational only (driving more
  // isn't "bad") and stays in a neutral tone.
  _deltaBadge(curr, prev, { percent = true, judged = false } = {}) {
    if (prev == null || curr == null) return `<span class="stat-delta neutral">&nbsp;</span>`;
    let text, isUp;
    if (percent) {
      if (!prev) return `<span class="stat-delta neutral">${_t("newValue")}</span>`;
      const pct = ((curr - prev) / prev) * 100;
      isUp = pct >= 0;
      text = `${isUp ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)} %`;
    } else {
      const diff = curr - prev;
      isUp = diff >= 0;
      text = `${isUp ? "▲" : "▼"} ${Math.abs(Math.round(diff))}`;
    }
    const cls = judged ? (isUp ? "bad" : "good") : "neutral";
    return `<span class="stat-delta ${cls}">${text}</span>`;
  }

  _comparisonCaption() {
    const { startDate, endDate } = this._filters;
    if (!startDate || !endDate) return "";
    const days = Math.round((new Date(`${endDate}T00:00:00`) - new Date(`${startDate}T00:00:00`)) / 86400000) + 1;
    return days === 1 ? _t("vsPrevDay") : _t("vsPrevDays", { days });
  }

  _renderSkeleton() {
    const instrument = this.shadowRoot.getElementById("instrument");
    if (instrument) {
      instrument.classList.add("is-loading");
      if (!instrument.children.length) {
        instrument.innerHTML = Array.from({ length: 4 }).map(() => `
          <div class="stat"><div class="stat-value">0</div><div class="stat-label">&nbsp;</div></div>
        `).join("");
      }
    }
    const list = this.shadowRoot.getElementById("trip-list");
    if (list) {
      list.classList.remove("has-selection");
      list.innerHTML = Array.from({ length: 4 }).map(() => `
        <div class="skel-row">
          <div class="skeleton dot"></div>
          <div><div class="skeleton line"></div><div class="skeleton line short"></div></div>
          <div class="skeleton line" style="height:10px"></div>
        </div>`).join("");
    }
  }

  _renderInstrument() {
    const el = this.shadowRoot.getElementById("instrument");
    if (!el) return;
    el.classList.remove("is-loading");

    const cur = this._computeCurrentTotals();
    const prev = this._prevTotals;
    const prevAvg = prev && prev.distance_km > 0 ? (prev.kwh_used / prev.distance_km) * 100 : null;

    el.innerHTML = `
      <div class="stat">
        <div class="stat-value">${_fmtKm(cur.distance)}<span class="unit">km</span></div>
        <div class="stat-label">${_t("distance")}</div>
        ${this._deltaBadge(cur.distance, prev ? prev.distance_km : null)}
      </div>
      <div class="stat">
        <div class="stat-value">${cur.count}</div>
        <div class="stat-label">${_t("trips")}</div>
        ${this._deltaBadge(cur.count, prev ? prev.trip_count : null, { percent: false })}
      </div>
      <div class="stat">
        <div class="stat-value">${_fmtNum(cur.kwh, 1)}<span class="unit">kWh</span></div>
        <div class="stat-label">${_t("energy")}</div>
        ${this._deltaBadge(cur.kwh, prev ? prev.kwh_used : null)}
      </div>
      <div class="stat">
        <div class="stat-value">${cur.avg != null ? _fmtNum(cur.avg, 1) : "—"}<span class="unit">kWh/100 km</span></div>
        <div class="stat-label">${_t("avgConsumption")}</div>
        ${cur.avg != null ? this._deltaBadge(cur.avg, prevAvg, { judged: true }) : `<span class="stat-delta neutral">&nbsp;</span>`}
      </div>
      <div class="instrument-caption">${this._comparisonCaption()}</div>
    `;
  }

  // Just the dates — the trip count already sits in the readout above.
  _renderFilterSummary() {
    const el = this.shadowRoot.getElementById("filter-summary-text");
    if (!el) return;
    const { startDate, endDate, hourStart, hourEnd } = this._filters;
    let text = startDate && endDate ? _formatRange(startDate, endDate) : _t("allHistory");
    if (hourStart > 0 || hourEnd < 23) text += _t("hourRange", { from: _pad2(hourStart), to: _pad2(hourEnd) });
    el.textContent = text;
  }

  _drawMap() {
    if (!this._map || !this._L) return;

    this._mapLayers.forEach(l => l.remove());
    this._mapLayers = [];
    this._mapLayersByTrip = new Map();

    let bounds = null;
    const extendBounds = (pts) => {
      pts.forEach(p => {
        if (bounds) bounds.extend(p);
        else bounds = this._L.latLngBounds(p, p);
      });
    };

    this._trips.forEach((trip, i) => {
      const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
      const waypoints = (trip.waypoints || [])
        .filter(w => w && w.length >= 2)
        .map(w => [w[0], w[1]]);

      let points = waypoints.length >= 2 ? waypoints : [];
      if (points.length === 0) {
        if (trip.start_lat && trip.start_lon) points.push([trip.start_lat, trip.start_lon]);
        if (trip.end_lat && trip.end_lon)     points.push([trip.end_lat, trip.end_lon]);
      }

      // Downsample very dense tracks so the browser doesn't choke on
      // long trips (hours of GPS points every 30s) when rendering/fitting.
      if (points.length > MAX_TRIP_POINTS) {
        const stride = Math.ceil(points.length / MAX_TRIP_POINTS);
        const sampled = points.filter((_, idx) => idx % stride === 0);
        if (sampled[sampled.length - 1] !== points[points.length - 1]) {
          sampled.push(points[points.length - 1]);
        }
        points = sampled;
      }

      const layers = {};

      if (points.length >= 2) {
        const line = this._L.polyline(points, { color, weight: 3, opacity: 0.85 }).addTo(this._map);
        line.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(line);
        layers.line = line;
        extendBounds(points);
      }

      if (trip.start_lat && trip.start_lon) {
        const m = this._L.circleMarker([trip.start_lat, trip.start_lon], {
          radius: 5, color: "#fff", fillColor: color, fillOpacity: 1, weight: 2,
        }).addTo(this._map);
        m.bindTooltip(
          `${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)}<br>${_esc(trip.start_address || "")}`,
          { direction: "top" }
        );
        m.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(m);
        layers.startMarker = m;
      }
      if (trip.end_lat && trip.end_lon) {
        const m = this._L.circleMarker([trip.end_lat, trip.end_lon], {
          radius: 5, color: "#fff", fillColor: "#555", fillOpacity: 1, weight: 2,
        }).addTo(this._map);
        m.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(m);
        layers.endMarker = m;
      }

      this._mapLayersByTrip.set(trip.id, layers);
    });

    if (bounds) {
      try { this._map.fitBounds(bounds, { padding: [20, 20] }); } catch(_) {}
    }

    this._applyMapSelection();
    setTimeout(() => this._map && this._map.invalidateSize(), 150);
  }

  // Dims every trip on the map except the selected one (thicker line,
  // brought to front) so it's unambiguous which route is which once more
  // than a couple overlap. No-op (everything back to full opacity) when
  // nothing is selected.
  _applyMapSelection() {
    if (!this._mapLayersByTrip) return;
    const selectedId = this._selectedTrip ? this._selectedTrip.id : null;
    this._mapLayersByTrip.forEach(({ line, startMarker, endMarker }, id) => {
      const isSelected = selectedId != null && id === selectedId;
      const dimmed = selectedId != null && !isSelected;
      if (line) {
        line.setStyle({ opacity: dimmed ? 0.15 : 0.9, weight: isSelected ? 5 : 3 });
        if (isSelected) line.bringToFront();
      }
      [startMarker, endMarker].forEach(m => {
        if (!m) return;
        m.setStyle({ opacity: dimmed ? 0.25 : 1, fillOpacity: dimmed ? 0.25 : 1 });
        if (isSelected) m.bringToFront();
      });
    });
  }

  _renderList() {
    const list = this.shadowRoot.getElementById("trip-list");
    if (!list) return;

    if (this._trips.length === 0) {
      // Point somewhere that actually widens the view: this month, or the
      // whole year if this month is what came back empty.
      const next = this._quickFilter === "month" ? "year" : "month";
      list.classList.remove("has-selection");
      list.innerHTML = `
        <div class="empty-state">
          <p class="empty-title">${_t("emptyTitle")}</p>
          <p class="empty-body">${_t("emptyBody")}</p>
          <button class="btn btn-primary" id="empty-cta">${_t("show", { label: _quickLabel(next).toLowerCase() })}</button>
        </div>`;
      const cta = this.shadowRoot.getElementById("empty-cta");
      if (cta) cta.addEventListener("click", () => this._setQuickFilter(next));
      return;
    }

    // The town is only worth showing when it isn't the usual one — on a
    // phone it otherwise eats the room the street names need.
    const townCount = new Map();
    this._trips.forEach(t => [t.start_address, t.end_address].forEach(a => {
      const { town } = _splitAddress(a);
      if (town) townCount.set(town, (townCount.get(town) || 0) + 1);
    }));
    const homeTown = [...townCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const place = (addr) => {
      const { street, town } = _splitAddress(addr);
      const showTown = town && town !== homeTown && town !== street;
      return `${_esc(street)}${showTown ? `<span class="town">, ${_esc(town)}</span>` : ""}`;
    };

    // Trips arrive newest first; group consecutive ones by local day.
    const days = [];
    this._trips.forEach((trip, i) => {
      const key = _isoDate(new Date(trip.start_time));
      let day = days[days.length - 1];
      if (!day || day.key !== key) days.push(day = { key, items: [], km: 0 });
      day.items.push({ trip, i });
      day.km += trip.distance_km || 0;
    });

    const selectedId = this._selectedTrip ? this._selectedTrip.id : null;
    list.classList.toggle("has-selection", selectedId != null);
    list.innerHTML = days.map(day => `
      <section aria-label="${_esc(_dayLabel(day.key))}">
        <div class="day-head"><span>${_esc(_dayLabel(day.key))}</span><span class="day-km">${_fmtKm(day.km)} km</span></div>
        ${day.items.map(({ trip, i }) => {
          const open = trip.id === selectedId;
          return `
            <button class="trip" data-idx="${i}" aria-expanded="${open}" style="--route-color:${ROUTE_COLORS[i % ROUTE_COLORS.length]}">
              <span class="rail" aria-hidden="true"><i class="from"></i><i class="to"></i></span>
              <span class="time">${_formatTime(trip.start_time)}</span>
              <span class="place">${place(trip.start_address)}</span>
              <span class="val">${_fmtKm(trip.distance_km)} km</span>
              <span class="time">${_formatTime(trip.end_time)}</span>
              <span class="place">${place(trip.end_address)}</span>
              <span class="val energy">${trip.kwh_used != null ? `${_fmtNum(trip.kwh_used, 1)} kWh` : "—"}</span>
            </button>
            ${open ? this._tripDetailHTML(trip) : ""}`;
        }).join("")}
      </section>`).join("");

    list.querySelectorAll(".trip").forEach(row => {
      row.addEventListener("click", () => this._selectTrip(this._trips[Number(row.dataset.idx)]));
    });
  }

  _tripDetailHTML(trip) {
    const avg = trip.avg_kwh_per_100km != null ? `${_fmtNum(trip.avg_kwh_per_100km, 1)} kWh/100 km` : "—";
    const soc = trip.soc_used != null ? `${_fmtNum(trip.soc_used, 0)} %` : "—";
    const odo = trip.start_odometer != null && trip.end_odometer != null
      ? `${_fmtKm(trip.start_odometer)} → ${_fmtKm(trip.end_odometer)} km` : "—";
    return `
      <div class="trip-detail">
        <p class="where">
          ${_t("departure")}: <span>${_esc(trip.start_address || _t("unknownPlace"))}</span><br>
          ${_t("arrival")}: <span>${_esc(trip.end_address || _t("unknownPlace"))}</span>
        </p>
        <dl>
          <div><dt>${_t("duration")}</dt><dd>${_formatDuration(trip.start_time, trip.end_time)}</dd></div>
          <div><dt>${_t("consumption")}</dt><dd>${avg}</dd></div>
          <div><dt>${_t("batteryUsed")}</dt><dd>${soc}</dd></div>
          <div><dt>${_t("odometer")}</dt><dd>${odo}</dd></div>
        </dl>
      </div>`;
  }

  // Keeps the open trip (row + its detail) visible inside the list's own
  // scroll box — never scrolls the dashboard itself.
  _revealSelectedRow() {
    const list = this.shadowRoot.getElementById("trip-list");
    const row = list && list.querySelector('.trip[aria-expanded="true"]');
    if (!row) return;
    const head = row.parentElement.querySelector(".day-head");
    const detail = row.nextElementSibling && row.nextElementSibling.classList.contains("trip-detail")
      ? row.nextElementSibling : row;
    const top = row.offsetTop - (head ? head.offsetHeight : 0);
    const bottom = detail.offsetTop + detail.offsetHeight;
    let target = null;
    if (top < list.scrollTop) target = top;
    else if (bottom > list.scrollTop + list.clientHeight) target = Math.min(top, bottom - list.clientHeight);
    if (target == null) return;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({ top: target, behavior: reduce ? "auto" : "smooth" });
  }

  _selectTrip(trip) {
    // Clicking the already-selected trip again deselects it — the only way
    // back to seeing every route at full opacity without changing filters.
    const deselecting = this._selectedTrip && this._selectedTrip.id === trip.id;
    this._selectedTrip = deselecting ? null : trip;
    this._renderList();
    if (!deselecting) this._revealSelectedRow();

    if (!this._map || !this._L) return;
    this._applyMapSelection();
    if (deselecting) return;

    const pts = (trip.waypoints || []).filter(w => w && w.length >= 2).map(w => [w[0], w[1]]);
    const fallback = [
      trip.start_lat && trip.start_lon ? [trip.start_lat, trip.start_lon] : null,
      trip.end_lat   && trip.end_lon   ? [trip.end_lat, trip.end_lon] : null,
    ].filter(Boolean);
    const bounds = pts.length >= 2 ? pts : fallback;
    if (bounds.length > 0) {
      try { this._map.fitBounds(this._L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 14 }); } catch(_) {}
    }
  }

  getCardSize() { return 8; }
}

// HA can load this script through more than one path at once — the
// add_extra_js_url injection AND the registered Lovelace resource both
// point at the same URL. HA normally isolates that with a scoped custom
// element registry, but when that polyfill isn't available the second
// execution's define() throws "already been used with this registry" and
// aborts before window.customCards.push() below ever runs, which is why
// the card can silently fail to mount even though the first load
// registered it fine. Guard it so a duplicate load is a harmless no-op.
if (!customElements.get("mercedes-trips-card")) {
  customElements.define("mercedes-trips-card", MercedesTripsCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === "mercedes-trips-card")) {
  window.customCards.push({
    type: "mercedes-trips-card",
    name: "Mercedes Trips",
    description: _t("cardDescription"),
    preview: false,
  });
}
