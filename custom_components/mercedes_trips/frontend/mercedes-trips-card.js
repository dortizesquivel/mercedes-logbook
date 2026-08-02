/**
 * Mercedes Trips Card — Custom Lovelace card
 * Mapa multi-trayecto con Leaflet, filtros rápidos por periodo, stats
 * contextuales al filtro con comparativa vs. periodo anterior.
 */

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS  = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const BRAND_FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=JetBrains+Mono:wght@500;700&display=swap";

// Four colors, not ten — enough to tell recent trips apart on the map and
// in the list without turning either into a rainbow.
const ROUTE_COLORS = ["#00c2b2", "#ffb020", "#9a8cf0", "#ff6b5e"];

// Cap rendered waypoints per trip so long trips (hours of GPS points every
// 30s) don't stall the main thread when drawing/fitting the map.
const MAX_TRIP_POINTS = 300;

// deltaLabel stays short on purpose — it sits inside a narrow instrument
// cell next to the delta value, and the period it's "vs." is already
// named by the stat-label right above it.
const QUICK_FILTERS = [
  { key: "today",     label: "Hoy",          deltaLabel: "vs. ayer" },
  { key: "yesterday", label: "Ayer",         deltaLabel: "vs. anterior" },
  { key: "7d",        label: "7 días",       deltaLabel: "vs. anterior" },
  { key: "month",     label: "Este mes",     deltaLabel: "vs. anterior" },
  { key: "lastMonth", label: "Mes anterior", deltaLabel: "vs. anterior" },
  { key: "year",      label: "Este año",     deltaLabel: "vs. anterior" },
];
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
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function _formatDateOnly(isoDate) {
  // For bare "YYYY-MM-DD" strings — force local-time parsing so the date
  // doesn't shift a day in negative UTC-offset zones.
  if (!isoDate) return "—";
  return _formatDate(`${isoDate}T00:00:00`);
}
function _formatTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}
function _formatDuration(start, end) {
  if (!start || !end) return "—";
  const m = Math.round((new Date(end) - new Date(start)) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}min`;
}
function _fmtNum(v, decimals = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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
// the "vs. periodo anterior" delta on any range, including custom ones.
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
    this._prevLabel = "vs. periodo anterior";
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
    if (!this._rendered) {
      this._rendered = true;
      this._init();
    }
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
          --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
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
          display: flex; align-items: flex-start; justify-content: space-between;
          gap: 12px; padding: 18px 20px 14px;
        }
        .eyebrow {
          font-family: var(--font-mono); font-size: 0.66rem; font-weight: 500;
          letter-spacing: .14em; text-transform: uppercase; color: var(--accent);
          display: block; margin-bottom: 4px;
        }
        .card-title {
          font-family: var(--font-display); font-weight: 700; font-size: 1.25rem;
          margin: 0; text-wrap: balance;
        }
        .badge-live {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: var(--font-mono); font-size: 0.64rem; font-weight: 700;
          letter-spacing: .07em; text-transform: uppercase;
          color: var(--accent-on); background: var(--accent);
          padding: 5px 10px 5px 8px; border-radius: 100px; white-space: nowrap;
        }
        .badge-live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-on); animation: mt-pulse 1.8s ease-in-out infinite; }
        @keyframes mt-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

        /* ── Instrument strip: the trip-computer readout ────────────────
           Tinted with the theme's own accent over the theme's own card
           surface, so it reads as a distinct "readout" panel in any
           theme (light or dark) instead of forcing one look. */
        .instrument {
          margin: 0 20px 18px;
          background: color-mix(in srgb, var(--accent) 10%, var(--card-background-color, #1c1c1e));
          border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
          border-radius: 12px; padding: 14px 4px;
          display: grid; grid-template-columns: repeat(4, 1fr);
        }
        .instrument .stat {
          padding: 0 12px; border-left: 1px solid var(--divider-color, rgba(127,127,127,.2));
          display: flex; flex-direction: column; gap: 4px;
          /* Grid items default to min-width:auto, which refuses to shrink
             below the content's natural (unwrapped) width — that's what
             was pushing the delta text past the panel's rounded corners
             when the card renders narrower than the text needs. */
          min-width: 0;
        }
        .instrument .stat:first-child { padding-left: 4px; }
        .instrument .stat:last-child { padding-right: 4px; }
        .instrument .stat:first-child { border-left: none; }
        .stat-value {
          font-family: var(--font-mono); font-variant-numeric: tabular-nums;
          font-weight: 700; font-size: clamp(0.95rem, 2.4vw, 1.3rem);
          color: var(--primary-text-color, #fff); letter-spacing: -.01em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .stat-value .unit { font-size: 0.62em; font-weight: 500; color: var(--accent); margin-left: 3px; }
        .stat-label { font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color, #aaa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .stat-delta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 3px; font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; margin-top: 1px; min-height: 1em; line-height: 1.3; }
        .stat-delta.neutral { color: var(--secondary-text-color, #aaa); }
        .stat-delta.good { color: var(--good); }
        .stat-delta.bad { color: var(--bad); }
        .stat-delta .vs { color: var(--secondary-text-color, #aaa); opacity: .8; font-weight: 500; text-transform: none; letter-spacing: 0; }
        .instrument.is-loading .stat-value, .instrument.is-loading .stat-label, .instrument.is-loading .stat-delta { visibility: hidden; }

        /* ── Quick filters ───────────────────────────────────────────── */
        .filter-block { padding: 0 20px 16px; border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.08)); }
        .quick-filters { display: flex; gap: 6px; flex-wrap: wrap; }
        .chip {
          font-family: var(--font-mono); font-size: 0.72rem; font-weight: 600;
          background: rgba(127,127,127,0.12); border: 1px solid transparent;
          color: var(--secondary-text-color, #aaa); border-radius: 100px;
          padding: 7px 13px; cursor: pointer;
        }
        .chip:hover { color: var(--primary-text-color, #fff); }
        .chip.is-active { background: var(--accent); color: var(--accent-on); }
        .chip-custom { display: inline-flex; align-items: center; gap: 5px; }
        .chip-custom .caret { font-size: 0.65em; transition: transform .15s; }
        .chip-custom[aria-expanded="true"] .caret { transform: rotate(180deg); }
        .chip:focus-visible, .btn:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 2px;
        }

        .custom-range { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--divider-color, rgba(255,255,255,0.12)); }
        .field { display: flex; align-items: center; gap: 6px; background: rgba(127,127,127,0.1); border: 1px solid transparent; border-radius: 100px; padding: 5px 12px; }
        .field label { font-family: var(--font-mono); font-size: 0.64rem; letter-spacing: .05em; text-transform: uppercase; color: var(--secondary-text-color, #aaa); }
        .field input, .field select { border: none; background: transparent; color: inherit; font-family: var(--primary-font-family, sans-serif); font-size: 0.8rem; outline: none; }
        .field select { font-family: var(--font-mono); cursor: pointer; }
        .field .sep { color: var(--secondary-text-color, #aaa); font-size: 0.76rem; }
        .field:focus-within { border-color: var(--accent); }

        .btn {
          font-family: var(--font-mono); font-size: 0.7rem; font-weight: 700;
          letter-spacing: .05em; text-transform: uppercase; border: none;
          border-radius: 100px; padding: 8px 15px; cursor: pointer;
        }
        .btn-primary { background: var(--accent); color: var(--accent-on); }
        .btn-primary:hover { filter: brightness(1.1); }

        .filter-summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; font-size: 0.78rem; color: var(--secondary-text-color, #aaa); }
        .filter-summary b { color: var(--primary-text-color, #fff); font-weight: 600; }
        .filter-clear {
          font-family: var(--font-mono); font-size: 0.66rem; background: none; border: none;
          color: var(--secondary-text-color, #aaa); text-decoration: underline; text-underline-offset: 2px;
          cursor: pointer; padding: 2px;
        }
        .filter-clear:hover { color: var(--primary-text-color, #fff); }

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

        /* ── Full Leaflet CSS inlined — CDN link is a bonus; these rules
           are the authoritative source so HA's CSP cannot block them. ── */
        .leaflet-container {
          position: relative !important; overflow: hidden !important;
          background: #ddd; outline: 0; cursor: grab; -webkit-tap-highlight-color: transparent;
        }
        .leaflet-container:focus { outline: none; }
        .leaflet-container a { color: #0078A8; }
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

        .leaflet-control-zoom { border: 2px solid rgba(0,0,0,0.2); border-radius: 4px; }
        .leaflet-bar a, .leaflet-bar a:hover {
          background-color: #fff; border-bottom: 1px solid #ccc;
          width: 26px; height: 26px; display: block;
          text-align: center; line-height: 26px; text-decoration: none; color: black;
        }
        .leaflet-bar a:first-child { border-top-left-radius: 4px; border-top-right-radius: 4px; }
        .leaflet-bar a:last-child  { border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; border-bottom: none; }
        .leaflet-bar a.leaflet-disabled { cursor: default; background-color: #f4f4f4; color: #bbb; }

        .leaflet-zoom-animated { transition: transform 0.25s cubic-bezier(0,0,0.25,1); }
        .leaflet-pan-anim  .leaflet-tile, .leaflet-zoom-anim .leaflet-tile { transition: none; }
        .leaflet-zoom-anim .leaflet-zoom-animated { will-change: transform; }

        .leaflet-control-attribution, .leaflet-control-scale-line {
          padding: 0 5px; background: rgba(255,255,255,0.8); box-shadow: 0 0 5px #bbb;
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

        /* ── Trip list ───────────────────────────────────────────────── */
        .list-head, .trip-row, .list-total {
          display: grid; grid-template-columns: 30px 1fr 64px 64px 84px; gap: 8px;
          align-items: center; padding: 0 20px;
        }
        .list-head {
          padding-top: 4px; padding-bottom: 8px;
          font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: .07em; text-transform: uppercase;
          color: var(--secondary-text-color, #aaa);
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.08));
        }
        .list-head .num, .trip-row .num, .list-total .num { text-align: right; }
        .trip-list { max-height: 320px; overflow-y: auto; padding-bottom: 4px; }
        .trip-row {
          padding-top: 10px; padding-bottom: 10px;
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.06));
          cursor: pointer; font-size: 0.82rem;
        }
        .trip-row:hover { background: rgba(127,127,127,0.08); }
        .trip-row.selected { background: rgba(127,127,127,0.14); }

        /* route glyph: start · spine · end — echoes the polyline on the map */
        .glyph { width: 12px; height: 32px; position: relative; margin: 0 auto; }
        .glyph i { position: absolute; left: 50%; transform: translateX(-50%); width: 7px; height: 7px; border-radius: 50%; }
        .glyph .start { top: 0; background: var(--route-color, var(--accent)); }
        .glyph .end { bottom: 0; background: var(--secondary-text-color, #aaa); opacity: .5; }
        .glyph .spine { position: absolute; left: 50%; top: 6px; bottom: 6px; width: 2px; transform: translateX(-50%); background: var(--route-color, var(--accent)); opacity: .35; }

        .trip-route { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .trip-route .main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .trip-route .sub { font-family: var(--font-mono); font-size: 0.66rem; color: var(--secondary-text-color, #aaa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .trip-row .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
        .trip-row .num.date { color: var(--secondary-text-color, #aaa); font-size: 0.7rem; }

        .list-total { padding-top: 10px; padding-bottom: 10px; background: rgba(127,127,127,0.06); border-top: 1px solid var(--divider-color, rgba(255,255,255,0.1)); }
        .list-total .label { grid-column: 2; font-family: var(--font-mono); font-size: 0.66rem; letter-spacing: .05em; text-transform: uppercase; color: var(--secondary-text-color, #aaa); }
        .list-total .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 700; font-size: 0.8rem; }

        /* ── Empty & loading states ──────────────────────────────────── */
        .empty-state { margin: 8px 20px 20px; padding: 30px 16px; text-align: center; border: 1px dashed var(--divider-color, rgba(255,255,255,0.15)); border-radius: 12px; }
        .empty-title { font-family: var(--font-display); font-weight: 700; font-size: 1rem; margin: 0 0 6px; }
        .empty-body { font-size: 0.82rem; color: var(--secondary-text-color, #aaa); max-width: 40ch; margin: 0 auto 14px; }
        .skeleton {
          background: linear-gradient(90deg, rgba(127,127,127,0.12) 25%, rgba(127,127,127,0.24) 50%, rgba(127,127,127,0.12) 75%);
          background-size: 200% 100%; border-radius: 6px; animation: mt-shimmer 1.6s ease-in-out infinite;
        }
        @keyframes mt-shimmer { to { background-position: -200% 0; } }
        .skel-row { display: grid; grid-template-columns: 30px 1fr 64px; gap: 8px; align-items: center; padding: 10px 20px; border-top: 1px solid var(--divider-color, rgba(255,255,255,0.06)); }
        .skel-row .skeleton.dot { width: 12px; height: 12px; border-radius: 50%; margin: 0 auto; }
        .skel-row .skeleton.line { height: 12px; }
        .skel-row .skeleton.line.short { width: 40%; margin-top: 6px; }

        /* ── Trip detail readout ─────────────────────────────────────── */
        .detail-panel { margin: 4px 20px 20px; padding: 14px 16px; border-radius: 12px; background: rgba(127,127,127,0.06); border: 1px solid var(--divider-color, rgba(255,255,255,0.08)); font-size: 0.82rem; display: none; }
        .detail-panel.visible { display: block; }
        .detail-route { font-family: var(--font-display); font-weight: 700; font-size: 0.96rem; margin: 0 0 10px; text-wrap: balance; }
        .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 8px; }
        .detail-item label { display: block; font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--secondary-text-color, #aaa); margin-bottom: 2px; }
        .detail-item span { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 700; }

        .active-badge { display: none; }

        /* Container queries react to this card's own rendered width, not
           the browser viewport — the correct signal in a dashboard where
           the same card can sit in a wide single-column view or a narrow
           "sections" grid column regardless of window size. */
        @container mt-card (max-width: 480px) {
          .instrument { grid-template-columns: repeat(2, 1fr); row-gap: 12px; }
          .instrument .stat:nth-child(3) { border-left: none; }
          .list-head, .trip-row, .list-total { grid-template-columns: 24px 1fr 50px 50px; }
          .list-head .date, .trip-row .date { display: none; }
          .detail-grid { grid-template-columns: repeat(2, 1fr); }
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
        }
      </style>
      <div class="card">
        <div class="card-header">
          <div>
            <span class="eyebrow">Mercedes-EQ · Cuaderno de ruta</span>
            <h2 class="card-title">Trayectos</h2>
          </div>
          <span id="active-badge" class="badge-live"><span class="dot"></span>En ruta</span>
        </div>

        <div class="instrument" id="instrument"></div>

        <div class="filter-block">
          <div class="quick-filters" role="group" aria-label="Filtros rápidos de periodo">
            ${QUICK_FILTERS.map(f => `<button class="chip" data-key="${f.key}">${f.label}</button>`).join("")}
            <button class="chip chip-custom" id="chip-custom" aria-expanded="false">Personalizado <span class="caret">▾</span></button>
          </div>
          <div class="custom-range" id="custom-range" style="display:none">
            <div class="field"><label>Desde</label><input type="date" id="f-start"></div>
            <div class="field"><label>Hasta</label><input type="date" id="f-end"></div>
            <div class="field">
              <label>Horario</label>
              <select id="f-hour-start">${Array.from({length:24}, (_,h) => `<option value="${h}">${_pad2(h)}:00</option>`).join("")}</select>
              <span class="sep">–</span>
              <select id="f-hour-end">${Array.from({length:24}, (_,h) => `<option value="${h}"${h===23?" selected":""}>${_pad2(h)}:00</option>`).join("")}</select>
            </div>
            <button class="btn btn-primary" id="btn-apply-custom">Aplicar</button>
          </div>
          <div class="filter-summary">
            <span id="filter-summary-text"></span>
            <button class="filter-clear" id="btn-clear-filter">Quitar filtro ✕</button>
          </div>
        </div>

        <div id="map-container">
          <div id="map"></div>
        </div>

        <div class="list-head">
          <div></div><div>Ruta</div><div class="num">km</div><div class="num">kWh</div><div class="num date">Fecha</div>
        </div>
        <div class="trip-list" id="trip-list"></div>
        <div class="list-total" id="list-total" style="display:none"></div>
        <div class="detail-panel" id="detail-panel"></div>
      </div>
    `;

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

    this._map = this._L.map(el, {
      zoomControl: true,
      preferCanvas: true,
    }).setView([40.4, -3.7], 6);

    this._L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>",
      maxZoom: 19,
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
    if (this._quickFilter !== "custom") {
      const panel = this.shadowRoot.getElementById("custom-range");
      const chip = this.shadowRoot.getElementById("chip-custom");
      if (panel) panel.style.display = "none";
      if (chip) chip.setAttribute("aria-expanded", "false");
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────

  async _fetchAndDraw() {
    // Guard against overlapping requests (e.g. clicking two chips fast).
    // A sequence number also lets the slower "previous period" fetch below
    // detect it's stale and avoid overwriting a newer filter's numbers.
    if (this._fetchInFlight) return;
    this._fetchInFlight = true;
    const seq = ++this._fetchSeq;

    this._renderSkeleton();

    const { startDate, endDate, hourStart, hourEnd } = this._filters;
    const params = new URLSearchParams({ limit: 200 });
    if (startDate) params.set("start_date", startDate);
    if (endDate)   params.set("end_date", endDate);
    if (hourStart > 0)  params.set("hour_start", hourStart);
    if (hourEnd < 23)   params.set("hour_end", hourEnd);

    try {
      const headers = this._haToken ? { Authorization: `Bearer ${this._haToken}` } : {};
      const resp = await fetch(`/api/mercedes_trips/trips?${params}`, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this._trips = data.trips || [];
      this._activeTrip = data.active_trip || null;
    } catch (e) {
      console.error("Mercedes Trips card: fetch error", e);
      this._trips = [];
      this._activeTrip = null;
    } finally {
      this._fetchInFlight = false;
    }

    if (seq !== this._fetchSeq) return; // a newer filter already superseded this one

    this._prevTotals = null;
    this._prevLabel = (QUICK_FILTERS.find(f => f.key === this._quickFilter) || {}).deltaLabel || "vs. periodo anterior";
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
    this._renderDetailPanel(this._selectedTrip);

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

  // Renders "▲ 12% vs. periodo anterior". `judged` marks stats where one
  // direction is objectively better (lower consumption), so the color
  // carries meaning; otherwise the delta is informational only (driving
  // more isn't "bad") and stays in a neutral tone.
  _deltaBadge(curr, prev, { percent = true, judged = false } = {}) {
    if (prev == null || curr == null) return `<span class="stat-delta neutral">&nbsp;</span>`;
    let text, isUp;
    if (percent) {
      if (!prev) return `<span class="stat-delta neutral">nuevo</span>`;
      const pct = ((curr - prev) / prev) * 100;
      isUp = pct >= 0;
      text = `${isUp ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%`;
    } else {
      const diff = curr - prev;
      isUp = diff >= 0;
      text = `${isUp ? "▲" : "▼"} ${Math.abs(Math.round(diff))}`;
    }
    const cls = judged ? (isUp ? "bad" : "good") : "neutral";
    return `<span class="stat-delta ${cls}">${text} <span class="vs">${this._prevLabel}</span></span>`;
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
      list.innerHTML = Array.from({ length: 4 }).map(() => `
        <div class="skel-row">
          <div class="skeleton dot"></div>
          <div><div class="skeleton line"></div><div class="skeleton line short"></div></div>
          <div class="skeleton line" style="height:10px"></div>
        </div>`).join("");
    }
    const total = this.shadowRoot.getElementById("list-total");
    if (total) total.style.display = "none";
  }

  _renderInstrument() {
    const el = this.shadowRoot.getElementById("instrument");
    if (!el) return;
    el.classList.remove("is-loading");

    const cur = this._computeCurrentTotals();
    const prev = this._prevTotals;
    const prevAvg = prev && prev.distance_km > 0 ? (prev.kwh_used / prev.distance_km) * 100 : null;
    const rangeLabel = (QUICK_FILTERS.find(f => f.key === this._quickFilter) || { label: "Periodo" }).label;

    el.innerHTML = `
      <div class="stat">
        <div class="stat-value">${_fmtNum(cur.distance, 1)}<span class="unit">km</span></div>
        <div class="stat-label">${rangeLabel}</div>
        ${this._deltaBadge(cur.distance, prev ? prev.distance_km : null)}
      </div>
      <div class="stat">
        <div class="stat-value">${cur.count}</div>
        <div class="stat-label">Trayectos</div>
        ${this._deltaBadge(cur.count, prev ? prev.trip_count : null, { percent: false })}
      </div>
      <div class="stat">
        <div class="stat-value">${_fmtNum(cur.kwh, 1)}<span class="unit">kWh</span></div>
        <div class="stat-label">Energía usada</div>
        ${this._deltaBadge(cur.kwh, prev ? prev.kwh_used : null)}
      </div>
      <div class="stat">
        <div class="stat-value">${cur.avg != null ? _fmtNum(cur.avg, 1) : "—"}<span class="unit">/100km</span></div>
        <div class="stat-label">Consumo medio</div>
        ${cur.avg != null ? this._deltaBadge(cur.avg, prevAvg, { judged: true }) : `<span class="stat-delta neutral">&nbsp;</span>`}
      </div>
    `;
  }

  _renderFilterSummary() {
    const el = this.shadowRoot.getElementById("filter-summary-text");
    if (!el) return;
    const n = this._trips.length;
    const { startDate, endDate } = this._filters;
    let rangeText = "todo el historial";
    if (startDate && endDate) {
      rangeText = startDate === endDate
        ? _formatDateOnly(startDate)
        : `${_formatDateOnly(startDate)} – ${_formatDateOnly(endDate)}`;
    }
    el.innerHTML = `<b>${n} trayecto${n === 1 ? "" : "s"}</b> · ${rangeText}`;
  }

  _drawMap() {
    if (!this._map || !this._L) return;

    this._mapLayers.forEach(l => l.remove());
    this._mapLayers = [];

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

      if (points.length >= 2) {
        const line = this._L.polyline(points, { color, weight: 3, opacity: 0.85 }).addTo(this._map);
        line.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(line);
        extendBounds(points);
      }

      if (trip.start_lat && trip.start_lon) {
        const m = this._L.circleMarker([trip.start_lat, trip.start_lon], {
          radius: 5, color: "#fff", fillColor: color, fillOpacity: 1, weight: 2,
        }).addTo(this._map);
        m.bindTooltip(
          `${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)}<br>${trip.start_address || ""}`,
          { direction: "top" }
        );
        m.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(m);
      }
      if (trip.end_lat && trip.end_lon) {
        const m = this._L.circleMarker([trip.end_lat, trip.end_lon], {
          radius: 5, color: "#fff", fillColor: "#555", fillOpacity: 1, weight: 2,
        }).addTo(this._map);
        m.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(m);
      }
    });

    if (bounds) {
      try { this._map.fitBounds(bounds, { padding: [20, 20] }); } catch(_) {}
    }

    setTimeout(() => this._map && this._map.invalidateSize(), 150);
  }

  _renderList() {
    const list = this.shadowRoot.getElementById("trip-list");
    const totalEl = this.shadowRoot.getElementById("list-total");
    if (!list) return;

    if (this._trips.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <p class="empty-title">Sin trayectos en este rango</p>
          <p class="empty-body">No hay viajes registrados en el periodo seleccionado. Prueba con un rango más amplio.</p>
          <button class="btn btn-primary" id="empty-cta">Ver este mes</button>
        </div>`;
      if (totalEl) totalEl.style.display = "none";
      const cta = this.shadowRoot.getElementById("empty-cta");
      if (cta) cta.addEventListener("click", () => this._setQuickFilter(DEFAULT_QUICK_FILTER));
      return;
    }

    list.innerHTML = this._trips.map((trip, i) => {
      const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
      const sel = this._selectedTrip && this._selectedTrip.id === trip.id ? " selected" : "";
      const km  = trip.distance_km != null ? trip.distance_km.toFixed(1) : "—";
      const kwh = trip.kwh_used != null ? trip.kwh_used.toFixed(2) : "—";
      return `
        <div class="trip-row${sel}" data-idx="${i}" style="--route-color:${color}">
          <div class="glyph"><i class="start"></i><i class="spine"></i><i class="end"></i></div>
          <div class="trip-route">
            <div class="main">${trip.start_address || "?"} → ${trip.end_address || "?"}</div>
            <div class="sub">${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)} · ${_formatDuration(trip.start_time, trip.end_time)}</div>
          </div>
          <div class="num">${km}</div>
          <div class="num">${kwh}</div>
          <div class="num date">${_formatDate(trip.start_time)}</div>
        </div>`;
    }).join("");

    list.querySelectorAll(".trip-row").forEach((row, i) => {
      row.addEventListener("click", () => this._selectTrip(this._trips[i]));
    });

    if (totalEl) {
      const cur = this._computeCurrentTotals();
      totalEl.style.display = "grid";
      totalEl.innerHTML = `
        <span class="label">Total filtrado</span>
        <span class="num" style="grid-column:3">${_fmtNum(cur.distance, 1)}</span>
        <span class="num" style="grid-column:4">${_fmtNum(cur.kwh, 1)}</span>`;
    }
  }

  _selectTrip(trip) {
    this._selectedTrip = trip;
    this._renderList();
    this._renderDetailPanel(trip);

    if (!this._map || !this._L) return;
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

  _renderDetailPanel(trip) {
    const panel = this.shadowRoot.getElementById("detail-panel");
    if (!panel) return;
    if (!trip) { panel.className = "detail-panel"; return; }

    const km  = trip.distance_km != null ? `${trip.distance_km.toFixed(2)} km` : "—";
    const kwh = trip.kwh_used != null ? `${trip.kwh_used.toFixed(2)} kWh` : "—";
    const avg = trip.avg_kwh_per_100km != null ? `${trip.avg_kwh_per_100km.toFixed(1)} /100km` : "—";
    const soc = trip.soc_used != null ? `${trip.soc_used.toFixed(0)}%` : "—";
    const wpts = (trip.waypoints || []).length;

    panel.className = "detail-panel visible";
    panel.innerHTML = `
      <p class="detail-route">${trip.start_address || "?"} → ${trip.end_address || "?"}</p>
      <div class="detail-grid">
        <div class="detail-item"><label>Inicio</label><span>${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)}</span></div>
        <div class="detail-item"><label>Fin</label><span>${_formatDate(trip.end_time)} ${_formatTime(trip.end_time)}</span></div>
        <div class="detail-item"><label>Duración</label><span>${_formatDuration(trip.start_time, trip.end_time)}</span></div>
        <div class="detail-item"><label>Distancia</label><span>${km}</span></div>
        <div class="detail-item"><label>Energía usada</label><span>${kwh}</span></div>
        <div class="detail-item"><label>Consumo</label><span>${avg}</span></div>
        <div class="detail-item"><label>SoC consumido</label><span>${soc}</span></div>
        <div class="detail-item"><label>Puntos GPS</label><span>${wpts}</span></div>
        <div class="detail-item"><label>Odómetro</label><span>${trip.start_odometer ?? "—"} → ${trip.end_odometer ?? "—"} km</span></div>
      </div>`;
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
    description: "Mapa de trayectos con filtros rápidos y estadísticas comparativas para Mercedes EQB",
    preview: false,
  });
}
