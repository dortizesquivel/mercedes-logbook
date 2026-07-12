/**
 * Mercedes Trips Card — Custom Lovelace card
 * Mapa multi-trayecto con Leaflet, filtros por fecha/hora, stats
 */

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS  = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

const TRIP_COLORS = [
  "#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261",
  "#6a4c93", "#1982c4", "#ff595e", "#06d6a0", "#fb8500",
];

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function _formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
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

class MercedesTripsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._trips = [];
    this._stats = {};
    this._map = null;
    this._mapLayers = [];
    this._selectedTrip = null;
    this._filters = { startDate: "", endDate: "", hourStart: 0, hourEnd: 23 };
    this._haToken = null;
    this._rendered = false;
    this._leafletLoading = false;
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
    // Then load Leaflet JS globally
    await _loadScript(LEAFLET_JS);
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
        :host { display: block; }
        .card {
          background: var(--card-background-color, #1c1c1e);
          border-radius: 12px;
          overflow: hidden;
          font-family: var(--primary-font-family, sans-serif);
          color: var(--primary-text-color, #fff);
        }
        .header { padding: 16px 20px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .header h2 { margin: 0; font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .stats-row {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px 20px;
        }
        .stat { background: rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 12px; }
        .stat-value { font-size: 1.3rem; font-weight: 700; }
        .stat-label { font-size: 0.7rem; color: var(--secondary-text-color, #aaa); margin-top: 2px; }
        .filters {
          padding: 10px 20px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .filters label { font-size: 0.75rem; color: var(--secondary-text-color, #aaa); }
        .filters input[type=date], .filters input[type=number] {
          background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
          border-radius: 6px; color: inherit; padding: 4px 8px; font-size: 0.8rem; width: 120px;
        }
        .filters input[type=number] { width: 52px; }
        .btn {
          background: var(--primary-color, #03a9f4); color: #fff; border: none;
          border-radius: 6px; padding: 5px 14px; cursor: pointer; font-size: 0.8rem;
        }

        /* ── Map container ─────────────────────────────────────────────────────
           Position MUST be relative so Leaflet's absolute children are clipped.
           Overflow hidden stops tiles spilling outside. No z-index here so we
           don't create an unwanted stacking context that fights the card flow.
        ─────────────────────────────────────────────────────────────────────── */
        #map-container {
          width: 100%;
          height: 380px;
          position: relative;
          overflow: hidden;
        }
        #map {
          width: 100%;
          height: 100%;
        }

        /* ── Full Leaflet CSS inlined — CDN link is a bonus; these rules are
           the authoritative source so HA's CSP cannot block them.            ── */

        /* Core: without position:relative on the container, tiles escape */
        .leaflet-container {
          position: relative !important;
          overflow: hidden !important;
          background: #ddd;
          outline: 0;
          cursor: grab;
          -webkit-tap-highlight-color: transparent;
        }
        .leaflet-container:focus { outline: none; }
        .leaflet-container a { color: #0078A8; }
        .leaflet-container a.leaflet-active { outline: 2px solid orange; }

        /* Pane positioning — every pane must be absolute inside the container */
        .leaflet-map-pane,
        .leaflet-tile,
        .leaflet-marker-icon,
        .leaflet-marker-shadow,
        .leaflet-tile-pane,
        .leaflet-overlay-pane,
        .leaflet-shadow-pane,
        .leaflet-marker-pane,
        .leaflet-popup-pane,
        .leaflet-map-pane canvas,
        .leaflet-map-pane svg { position: absolute; }

        .leaflet-map-pane { z-index: 2; top: 0; left: 0; }
        .leaflet-tile-pane    { z-index: 2; }
        .leaflet-overlay-pane { z-index: 4; }
        .leaflet-shadow-pane  { z-index: 5; }
        .leaflet-marker-pane  { z-index: 6; }
        .leaflet-tooltip-pane { z-index: 6; }
        .leaflet-popup-pane   { z-index: 7; }

        .leaflet-pane { position: absolute; top: 0; left: 0; }
        .leaflet-pane > svg,
        .leaflet-pane > canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }

        .leaflet-tile-container { pointer-events: none; }
        .leaflet-tile { position: absolute; image-rendering: auto; }
        .leaflet-zoom-box { width: 0; height: 0; box-sizing: border-box; z-index: 800; }

        /* Controls */
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
          text-align: center; line-height: 26px;
          text-decoration: none; color: black;
        }
        .leaflet-bar a:first-child { border-top-left-radius: 4px; border-top-right-radius: 4px; }
        .leaflet-bar a:last-child  { border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; border-bottom: none; }
        .leaflet-bar a.leaflet-disabled { cursor: default; background-color: #f4f4f4; color: #bbb; }

        /* Animations */
        .leaflet-zoom-animated { transition: transform 0.25s cubic-bezier(0,0,0.25,1); }
        .leaflet-pan-anim  .leaflet-tile,
        .leaflet-zoom-anim .leaflet-tile { transition: none; }
        .leaflet-zoom-anim .leaflet-zoom-animated { will-change: transform; }

        /* Attribution / tooltip */
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

        /* Fade animation */
        .leaflet-fade-anim .leaflet-popup { opacity: 0; transition: opacity 0.2s linear; }
        .leaflet-fade-anim .leaflet-map-pane .leaflet-popup { opacity: 1; }

        .trip-list { max-height: 320px; overflow-y: auto; }
        .trip-row {
          display: grid; grid-template-columns: 32px 1fr 72px 72px 72px; gap: 6px;
          align-items: center; padding: 8px 20px; border-bottom: 1px solid rgba(255,255,255,0.05);
          cursor: pointer; transition: background .15s; font-size: 0.8rem;
        }
        .trip-row:hover { background: rgba(255,255,255,0.06); }
        .trip-row.selected { background: rgba(255,255,255,0.12); }
        .trip-dot { width: 12px; height: 12px; border-radius: 50%; margin: 0 auto; }
        .trip-route-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .trip-route-sub { font-size: 0.7rem; color: var(--secondary-text-color, #aaa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .trip-num { text-align: right; }
        .trip-list-header {
          display: grid; grid-template-columns: 32px 1fr 72px 72px 72px; gap: 6px;
          padding: 6px 20px; font-size: 0.7rem; color: var(--secondary-text-color, #aaa);
          border-bottom: 1px solid rgba(255,255,255,0.1); border-top: 1px solid rgba(255,255,255,0.06);
        }
        .detail-panel {
          padding: 12px 20px; background: rgba(255,255,255,0.04);
          border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.82rem; display: none;
        }
        .detail-panel.visible { display: block; }
        .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
        .detail-item label { font-size: 0.7rem; color: var(--secondary-text-color, #aaa); }
        .detail-item span { font-weight: 600; }
        .loading { text-align: center; padding: 40px; color: var(--secondary-text-color, #aaa); }
        .active-badge {
          background: #2a9d8f; color: #fff; font-size: 0.65rem;
          padding: 2px 7px; border-radius: 10px; margin-left: 8px;
        }
      </style>
      <div class="card">
        <div class="header">
          <h2>🚗 Trayectos Mercedes EQB
            <span id="active-badge" class="active-badge" style="display:none">EN CURSO</span>
          </h2>
        </div>
        <div class="stats-row">
          <div class="stat"><div class="stat-value" id="stat-km-month">—</div><div class="stat-label">km este mes</div></div>
          <div class="stat"><div class="stat-value" id="stat-km-year">—</div><div class="stat-label">km este año</div></div>
          <div class="stat"><div class="stat-value" id="stat-kwh-month">—</div><div class="stat-label">kWh mes</div></div>
          <div class="stat"><div class="stat-value" id="stat-avg">—</div><div class="stat-label">kWh/100km</div></div>
        </div>
        <div class="filters">
          <label>Desde <input type="date" id="f-start"></label>
          <label>Hasta <input type="date" id="f-end"></label>
          <label>Hora inicio <input type="number" id="f-hour-start" min="0" max="23" value="0"></label>
          <label>Hora fin <input type="number" id="f-hour-end" min="0" max="23" value="23"></label>
          <button class="btn" id="btn-filter">Filtrar</button>
          <button class="btn" id="btn-reset" style="background:rgba(255,255,255,0.12)">Reset</button>
        </div>
        <div id="map-container">
          <div id="map"></div>
        </div>
        <div class="trip-list-header">
          <div></div><div>Ruta</div><div class="trip-num">km</div><div class="trip-num">kWh</div><div class="trip-num">Fecha</div>
        </div>
        <div class="trip-list" id="trip-list"><div class="loading">Cargando trayectos…</div></div>
        <div class="detail-panel" id="detail-panel"></div>
      </div>
    `;

    this.shadowRoot.getElementById("btn-filter").addEventListener("click", () => this._applyFilter());
    this.shadowRoot.getElementById("btn-reset").addEventListener("click", () => this._resetFilter());
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
    if (!window.L) return;

    const el = this.shadowRoot && this.shadowRoot.getElementById("map");
    if (!el) return;

    // Final dimension guard
    const { width, height } = el.getBoundingClientRect();
    if (width === 0 || height === 0) {
      setTimeout(() => this._scheduleMapInit(), 200);
      return;
    }

    this._map = window.L.map(el, {
      zoomControl: true,
      preferCanvas: true,
    }).setView([40.4, -3.7], 6);

    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>",
      maxZoom: 19,
    }).addTo(this._map);

    this._map.invalidateSize();

    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (this._map) this._map.invalidateSize();
      }).observe(el);
    }

    // If data was already fetched before map was ready, draw now
    if (this._trips.length > 0) this._drawMap();
  }

  _applyFilter() {
    this._filters.startDate = this.shadowRoot.getElementById("f-start").value;
    this._filters.endDate   = this.shadowRoot.getElementById("f-end").value;
    this._filters.hourStart = parseInt(this.shadowRoot.getElementById("f-hour-start").value) || 0;
    this._filters.hourEnd   = parseInt(this.shadowRoot.getElementById("f-hour-end").value) || 23;
    this._fetchAndDraw();
  }

  _resetFilter() {
    this._filters = { startDate: "", endDate: "", hourStart: 0, hourEnd: 23 };
    this.shadowRoot.getElementById("f-start").value = "";
    this.shadowRoot.getElementById("f-end").value = "";
    this.shadowRoot.getElementById("f-hour-start").value = 0;
    this.shadowRoot.getElementById("f-hour-end").value = 23;
    this._fetchAndDraw();
  }

  async _fetchAndDraw() {
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
      this._stats = data.stats || {};
      this._activeTrip = data.active_trip || null;
    } catch (e) {
      console.error("Mercedes Trips card: fetch error", e);
      this._trips = [];
      this._stats = {};
    }

    this._updateStats();
    this._drawMap();
    this._renderList();
    this._renderDetailPanel(this._selectedTrip);
  }

  _updateStats() {
    const s = this._stats;
    const R = (v) => v != null ? Math.round(v * 10) / 10 : "—";
    const set = (id, val) => { const el = this.shadowRoot.getElementById(id); if (el) el.textContent = val; };
    set("stat-km-month",  R(s.distance_this_month));
    set("stat-km-year",   R(s.distance_this_year));
    set("stat-kwh-month", R(s.kwh_this_month));
    set("stat-avg",       R(s.avg_kwh_per_100km));
    const badge = this.shadowRoot.getElementById("active-badge");
    if (badge) badge.style.display = this._activeTrip ? "inline-block" : "none";
  }

  _drawMap() {
    if (!this._map || !window.L) return;

    this._mapLayers.forEach(l => l.remove());
    this._mapLayers = [];

    const allBounds = [];
    this._trips.forEach((trip, i) => {
      const color = TRIP_COLORS[i % TRIP_COLORS.length];
      const waypoints = (trip.waypoints || [])
        .filter(w => w && w.length >= 2)
        .map(w => [w[0], w[1]]);

      let points = waypoints.length >= 2 ? waypoints : [];
      if (points.length === 0) {
        if (trip.start_lat && trip.start_lon) points.push([trip.start_lat, trip.start_lon]);
        if (trip.end_lat && trip.end_lon)     points.push([trip.end_lat, trip.end_lon]);
      }

      if (points.length >= 2) {
        const line = window.L.polyline(points, { color, weight: 3, opacity: 0.85 }).addTo(this._map);
        line.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(line);
        allBounds.push(...points);
      }

      if (trip.start_lat && trip.start_lon) {
        const m = window.L.circleMarker([trip.start_lat, trip.start_lon], {
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
        const m = window.L.circleMarker([trip.end_lat, trip.end_lon], {
          radius: 5, color: "#fff", fillColor: "#555", fillOpacity: 1, weight: 2,
        }).addTo(this._map);
        m.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(m);
      }
    });

    if (allBounds.length > 0) {
      try { this._map.fitBounds(window.L.latLngBounds(allBounds), { padding: [20, 20] }); } catch(_) {}
    }

    setTimeout(() => this._map && this._map.invalidateSize(), 150);
  }

  _renderList() {
    const list = this.shadowRoot.getElementById("trip-list");
    if (!list) return;
    if (this._trips.length === 0) {
      list.innerHTML = `<div class="loading">Sin trayectos para los filtros seleccionados</div>`;
      return;
    }
    list.innerHTML = this._trips.map((trip, i) => {
      const color = TRIP_COLORS[i % TRIP_COLORS.length];
      const sel = this._selectedTrip && this._selectedTrip.id === trip.id ? " selected" : "";
      const km  = trip.distance_km != null ? trip.distance_km.toFixed(1) : "—";
      const kwh = trip.kwh_used != null ? trip.kwh_used.toFixed(2) : "—";
      return `
        <div class="trip-row${sel}" data-idx="${i}">
          <div><div class="trip-dot" style="background:${color}"></div></div>
          <div>
            <div class="trip-route-main">${trip.start_address || "?"} → ${trip.end_address || "?"}</div>
            <div class="trip-route-sub">${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)} · ${_formatDuration(trip.start_time, trip.end_time)}</div>
          </div>
          <div class="trip-num">${km}</div>
          <div class="trip-num">${kwh}</div>
          <div class="trip-num" style="font-size:0.7rem">${_formatDate(trip.start_time)}</div>
        </div>`;
    }).join("");

    list.querySelectorAll(".trip-row").forEach((row, i) => {
      row.addEventListener("click", () => this._selectTrip(this._trips[i]));
    });
  }

  _selectTrip(trip) {
    this._selectedTrip = trip;
    this._renderList();
    this._renderDetailPanel(trip);

    if (!this._map || !window.L) return;
    const pts = (trip.waypoints || []).filter(w => w && w.length >= 2).map(w => [w[0], w[1]]);
    const fallback = [
      trip.start_lat && trip.start_lon ? [trip.start_lat, trip.start_lon] : null,
      trip.end_lat   && trip.end_lon   ? [trip.end_lat, trip.end_lon] : null,
    ].filter(Boolean);
    const bounds = pts.length >= 2 ? pts : fallback;
    if (bounds.length > 0) {
      try { this._map.fitBounds(window.L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 14 }); } catch(_) {}
    }
  }

  _renderDetailPanel(trip) {
    const panel = this.shadowRoot.getElementById("detail-panel");
    if (!panel) return;
    if (!trip) { panel.className = "detail-panel"; return; }

    const km  = trip.distance_km != null ? `${trip.distance_km.toFixed(2)} km` : "—";
    const kwh = trip.kwh_used != null ? `${trip.kwh_used.toFixed(2)} kWh` : "—";
    const avg = trip.avg_kwh_per_100km != null ? `${trip.avg_kwh_per_100km.toFixed(1)} kWh/100km` : "—";
    const soc = trip.soc_used != null ? `${trip.soc_used.toFixed(0)}%` : "—";
    const wpts = (trip.waypoints || []).length;

    panel.className = "detail-panel visible";
    panel.innerHTML = `
      <strong>${trip.start_address || "?"} → ${trip.end_address || "?"}</strong>
      <div class="detail-grid">
        <div class="detail-item"><label>Inicio</label><br><span>${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)}</span></div>
        <div class="detail-item"><label>Fin</label><br><span>${_formatDate(trip.end_time)} ${_formatTime(trip.end_time)}</span></div>
        <div class="detail-item"><label>Duración</label><br><span>${_formatDuration(trip.start_time, trip.end_time)}</span></div>
        <div class="detail-item"><label>Distancia</label><br><span>${km}</span></div>
        <div class="detail-item"><label>Energía usada</label><br><span>${kwh}</span></div>
        <div class="detail-item"><label>Consumo</label><br><span>${avg}</span></div>
        <div class="detail-item"><label>SoC consumido</label><br><span>${soc}</span></div>
        <div class="detail-item"><label>Puntos GPS</label><br><span>${wpts}</span></div>
        <div class="detail-item"><label>Odómetro</label><br><span>${trip.start_odometer ?? "—"} → ${trip.end_odometer ?? "—"} km</span></div>
      </div>`;
  }

  getCardSize() { return 7; }

  static getConfigElement() {
    return document.createElement("mercedes-trips-card-editor");
  }

  static getStubConfig() {
    return {};
  }
}

customElements.define("mercedes-trips-card", MercedesTripsCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "mercedes-trips-card",
  name: "Mercedes Trips",
  description: "Mapa de trayectos con filtros y estadísticas para Mercedes EQB",
  preview: false,
});
