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
function _loadCSS(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href;
  document.head.appendChild(l);
}

function _formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function _formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}
function _formatDuration(start, end) {
  if (!start || !end) return "—";
  const ms = new Date(end) - new Date(start);
  const m = Math.round(ms / 60000);
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
    this._filters = {
      startDate: "",
      endDate: "",
      hourStart: 0,
      hourEnd: 23,
    };
    this._leafletReady = false;
    this._haToken = null;
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
      this._render();
      this._rendered = true;
    }
  }

  async _render() {
    _loadCSS(LEAFLET_CSS);
    await _loadScript(LEAFLET_JS);
    this._leafletReady = true;
    this._buildDOM();
    await this._fetchAndDraw();
  }

  _buildDOM() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card { background: var(--card-background-color, #1c1c1e); border-radius: 12px; overflow: hidden; font-family: var(--primary-font-family, sans-serif); color: var(--primary-text-color, #fff); position: relative; }
        .header { padding: 16px 20px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .header h2 { margin: 0; font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px 20px; position: relative; z-index: 1; }
        .stat { background: rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 12px; }
        .stat-value { font-size: 1.3rem; font-weight: 700; }
        .stat-label { font-size: 0.7rem; color: var(--secondary-text-color, #aaa); margin-top: 2px; }
        .filters { padding: 10px 20px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; position: relative; z-index: 1; }
        .filters label { font-size: 0.75rem; color: var(--secondary-text-color, #aaa); }
        .filters input[type=date], .filters input[type=number] { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: inherit; padding: 4px 8px; font-size: 0.8rem; width: 120px; }
        .filters input[type=number] { width: 52px; }
        .btn { background: var(--primary-color, #03a9f4); color: #fff; border: none; border-radius: 6px; padding: 5px 14px; cursor: pointer; font-size: 0.8rem; }
        /* Critical Leaflet fixes for Shadow DOM */
        .map-wrap { width: 100%; height: 380px; position: relative; overflow: hidden; z-index: 0; }
        #map { width: 100%; height: 100%; position: absolute; top: 0; left: 0; }
        .leaflet-container { font-family: inherit; }
        .leaflet-pane, .leaflet-pane > svg, .leaflet-pane > canvas,
        .leaflet-zoom-box, .leaflet-image-layer, .leaflet-layer { position: absolute; top: 0; left: 0; }
        .leaflet-tile-container { pointer-events: none; }
        .leaflet-tile { filter: none; }
        .trip-list { max-height: 320px; overflow-y: auto; position: relative; z-index: 1; }
        .trip-row { display: grid; grid-template-columns: 32px 1fr 72px 72px 72px; gap: 6px; align-items: center; padding: 8px 20px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: background .15s; font-size: 0.8rem; }
        .trip-row:hover { background: rgba(255,255,255,0.06); }
        .trip-row.selected { background: rgba(255,255,255,0.12); }
        .trip-dot { width: 12px; height: 12px; border-radius: 50%; margin: 0 auto; }
        .trip-route { overflow: hidden; }
        .trip-route-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .trip-route-sub { font-size: 0.7rem; color: var(--secondary-text-color, #aaa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .trip-num { text-align: right; }
        .trip-list-header { display: grid; grid-template-columns: 32px 1fr 72px 72px 72px; gap: 6px; padding: 6px 20px; font-size: 0.7rem; color: var(--secondary-text-color, #aaa); border-bottom: 1px solid rgba(255,255,255,0.1); position: relative; z-index: 1; }
        .detail-panel { padding: 12px 20px; background: rgba(255,255,255,0.04); border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.82rem; display: none; position: relative; z-index: 1; }
        .detail-panel.visible { display: block; }
        .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
        .detail-item label { font-size: 0.7rem; color: var(--secondary-text-color, #aaa); }
        .detail-item span { font-weight: 600; }
        .loading { text-align: center; padding: 40px; color: var(--secondary-text-color, #aaa); }
        .active-badge { background: #2a9d8f; color: #fff; font-size: 0.65rem; padding: 2px 7px; border-radius: 10px; margin-left: 8px; }
      </style>
      <div class="card">
        <div class="header">
          <h2>🚗 Trayectos Mercedes EQB <span id="active-badge" class="active-badge" style="display:none">EN CURSO</span></h2>
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
        <div class="map-wrap"><div id="map"></div></div>
        <div class="trip-list-header">
          <div></div><div>Ruta</div><div class="trip-num">km</div><div class="trip-num">kWh</div><div class="trip-num">Fecha</div>
        </div>
        <div class="trip-list" id="trip-list"><div class="loading">Cargando trayectos…</div></div>
        <div class="detail-panel" id="detail-panel"></div>
      </div>
    `;

    this._mapEl = this.shadowRoot.getElementById("map");
    // Init map after two animation frames so Shadow DOM dimensions are settled
    requestAnimationFrame(() => requestAnimationFrame(() => this._initMap()));

    this.shadowRoot.getElementById("btn-filter").addEventListener("click", () => this._applyFilter());
    this.shadowRoot.getElementById("btn-reset").addEventListener("click", () => this._resetFilter());
  }

  _initMap() {
    if (!window.L || this._map) return;
    const el = this._mapEl;
    if (!el) return;

    this._map = window.L.map(el, {
      zoomControl: true,
      preferCanvas: true,
    }).setView([40.4, -3.7], 6);

    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    }).addTo(this._map);

    // Ensure correct size after init and whenever the card resizes
    this._map.invalidateSize();
    if (window.ResizeObserver) {
      new ResizeObserver(() => this._map && this._map.invalidateSize()).observe(el);
    }
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
    }

    this._updateStats();
    this._drawMap();
    this._renderList();
    this._renderDetailPanel(this._selectedTrip);
  }

  _updateStats() {
    const s = this._stats;
    const R = (v, d) => v != null ? Math.round(v * 10) / 10 : d;
    this.shadowRoot.getElementById("stat-km-month").textContent  = R(s.distance_this_month, "—");
    this.shadowRoot.getElementById("stat-km-year").textContent   = R(s.distance_this_year, "—");
    this.shadowRoot.getElementById("stat-kwh-month").textContent = R(s.kwh_this_month, "—");
    this.shadowRoot.getElementById("stat-avg").textContent       = R(s.avg_kwh_per_100km, "—");
    const badge = this.shadowRoot.getElementById("active-badge");
    if (badge) badge.style.display = this._activeTrip ? "inline-block" : "none";
  }

  _drawMap() {
    if (!this._map) return;
    // Remove previous layers
    this._mapLayers.forEach(l => l.remove());
    this._mapLayers = [];

    const allBounds = [];
    this._trips.forEach((trip, i) => {
      const color = TRIP_COLORS[i % TRIP_COLORS.length];
      const waypoints = (trip.waypoints || [])
        .filter(w => w && w.length >= 2)
        .map(w => [w[0], w[1]]);

      if (waypoints.length < 2) {
        // Only start/end points
        const points = [];
        if (trip.start_lat && trip.start_lon) points.push([trip.start_lat, trip.start_lon]);
        if (trip.end_lat && trip.end_lon)     points.push([trip.end_lat, trip.end_lon]);
        if (points.length === 2) {
          const line = window.L.polyline(points, { color, weight: 3, opacity: 0.8 }).addTo(this._map);
          line.on("click", () => this._selectTrip(trip));
          this._mapLayers.push(line);
          allBounds.push(...points);
        }
      } else {
        const line = window.L.polyline(waypoints, { color, weight: 3, opacity: 0.8 }).addTo(this._map);
        line.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(line);
        allBounds.push(...waypoints);
      }

      // Start marker
      if (trip.start_lat && trip.start_lon) {
        const m = window.L.circleMarker([trip.start_lat, trip.start_lon], {
          radius: 5, color: "#fff", fillColor: color, fillOpacity: 1, weight: 2,
        }).addTo(this._map);
        m.bindTooltip(`${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)}<br>${trip.start_address || ""}`, { direction: "top" });
        m.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(m);
      }
      // End marker
      if (trip.end_lat && trip.end_lon) {
        const m = window.L.circleMarker([trip.end_lat, trip.end_lon], {
          radius: 5, color: "#fff", fillColor: "#666", fillOpacity: 1, weight: 2,
        }).addTo(this._map);
        m.on("click", () => this._selectTrip(trip));
        this._mapLayers.push(m);
      }
    });

    if (allBounds.length > 0) {
      try { this._map.fitBounds(window.L.latLngBounds(allBounds), { padding: [20, 20] }); } catch(_) {}
    }

    // Force re-render after shadow DOM paint
    setTimeout(() => this._map && this._map.invalidateSize(), 100);
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
      const isSelected = this._selectedTrip && this._selectedTrip.id === trip.id;
      const km = trip.distance_km != null ? trip.distance_km.toFixed(1) : "—";
      const kwh = trip.kwh_used != null ? trip.kwh_used.toFixed(2) : "—";
      return `
        <div class="trip-row${isSelected ? " selected" : ""}" data-idx="${i}">
          <div><div class="trip-dot" style="background:${color}"></div></div>
          <div class="trip-route">
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

    // Zoom map to trip
    if (!this._map || !window.L) return;
    const waypoints = (trip.waypoints || []).filter(w => w && w.length >= 2).map(w => [w[0], w[1]]);
    const points = waypoints.length >= 2 ? waypoints : [
      trip.start_lat && trip.start_lon ? [trip.start_lat, trip.start_lon] : null,
      trip.end_lat && trip.end_lon     ? [trip.end_lat, trip.end_lon] : null,
    ].filter(Boolean);
    if (points.length > 0) {
      try { this._map.fitBounds(window.L.latLngBounds(points), { padding: [30, 30], maxZoom: 14 }); } catch(_) {}
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
    const dur = _formatDuration(trip.start_time, trip.end_time);
    const wpts = (trip.waypoints || []).length;

    panel.className = "detail-panel visible";
    panel.innerHTML = `
      <strong>${trip.start_address || "?"} → ${trip.end_address || "?"}</strong>
      <div class="detail-grid">
        <div class="detail-item"><label>Inicio</label><br><span>${_formatDate(trip.start_time)} ${_formatTime(trip.start_time)}</span></div>
        <div class="detail-item"><label>Fin</label><br><span>${_formatDate(trip.end_time)} ${_formatTime(trip.end_time)}</span></div>
        <div class="detail-item"><label>Duración</label><br><span>${dur}</span></div>
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
