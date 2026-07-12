# Mercedes Trips for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![GitHub release](https://img.shields.io/github/release/dortizesquivel/mercedes-logbook.svg)](https://github.com/dortizesquivel/mercedes-logbook/releases)
[![License](https://img.shields.io/github/license/dortizesquivel/mercedes-logbook.svg)](LICENSE)

Registra automáticamente cada trayecto realizado con tu Mercedes eléctrico/PHEV directamente en Home Assistant — sin servicios externos, sin suscripciones. Almacena inicio, fin, distancia, consumo (kWh), waypoints GPS y direcciones geocodificadas en una base de datos SQLite local.

Incluye una **Lovelace card** con mapa multi-trayecto, filtros por fecha/hora y estadísticas mensuales.

![Mercedes Trips Card](https://raw.githubusercontent.com/dortizesquivel/mercedes-logbook/main/docs/screenshot.png)

---

## Características

- 🗺️ **Mapa interactivo** con todos los trayectos en colores distintos (Leaflet + OpenStreetMap)
- 🔍 **Filtros** por fecha y franja horaria
- ⚡ **Consumo real** calculado a partir del SoC y la capacidad de batería
- 📍 **Geocodificación automática** de inicio y fin (Nominatim/OSM, sin API key)
- 💾 **SQLite local** — los datos son tuyos, no se purgan con el recorder
- 🔄 **Detección por odómetro** — registra paradas intermedias como trayectos independientes
- 🧲 **Waypoints GPS** cada 30 segundos durante el trayecto
- 🔌 **REST API** interna para consultar y filtrar trayectos
- 7 **sensores** de Home Assistant: km/mes, km/año, kWh/mes, consumo medio, total trayectos, último trayecto, trayecto activo

---

## Requisitos

- Home Assistant 2024.1+
- Integración [mbapi2020](https://github.com/ReneNulschDE/mbapi2020) instalada y configurada
- Mercedes eléctrico o PHEV con conectividad Mercedes me

---

## Instalación

### Via HACS (recomendado)

1. Abre HACS en Home Assistant
2. Ve a **Integrations → ⋮ → Custom repositories**
3. Añade `dortizesquivel/mercedes-logbook` con categoría **Integration**
4. Busca **Mercedes Trips** e instala
5. Reinicia Home Assistant

La Lovelace card se registra automáticamente al cargar la integración. No necesitas copiar archivos ni registrar recursos manualmente.

### Manual

1. Descarga la [última release](https://github.com/dortizesquivel/mercedes-logbook/releases)
2. Copia `custom_components/mercedes_trips/` a tu carpeta `/config/custom_components/`
3. Reinicia Home Assistant

---

## Configuración

1. Ve a **Ajustes → Dispositivos y servicios → + Añadir integración**
2. Busca **Mercedes Trips**
3. Rellena el formulario:

| Campo | Descripción | Por defecto (EQB 300) |
|---|---|---|
| Sensor de odómetro | `sensor.*_odometer` | `sensor.eqb_300_odometer` |
| Device tracker (GPS) | `device_tracker.*_device_tracker` | `device_tracker.eqb_300_device_tracker` |
| Sensor de batería (SoC %) | `sensor.*_state_of_charge` | `sensor.eqb_300_state_of_charge` |
| Sensor de autonomía | `sensor.*_range_electric` | `sensor.eqb_300_range_electric` |
| Capacidad útil de batería (kWh) | Capacidad usable de tu modelo | `66.5` (EQB 300 4MATIC) |
| Minutos de inactividad para cerrar trayecto | Tiempo sin movimiento antes de cerrar | `8` |
| Distancia mínima de trayecto (km) | Trayectos más cortos se descartan | `0.5` |

---

## Lovelace Card

Añade la tarjeta a cualquier dashboard:

```yaml
type: custom:mercedes-trips-card
```

### Funcionalidades de la card

- **Mapa**: trayectos como polilíneas con colores distintos; clic en un trayecto para ver el detalle y centrar el mapa
- **Filtros**: por fecha de inicio, fecha de fin, hora de inicio y hora de fin
- **Estadísticas**: km este mes, km este año, kWh este mes, consumo medio
- **Lista de trayectos**: origen → destino, duración, km, kWh, fecha
- **Panel de detalle**: distancia, energía, consumo, SoC usado, puntos GPS, odómetro inicio/fin

---

## Sensores

| Entity | Descripción |
|---|---|
| `sensor.mercedes_trips_distancia_este_mes` | km recorridos en el mes actual |
| `sensor.mercedes_trips_distancia_este_ano` | km recorridos en el año actual |
| `sensor.mercedes_trips_kwh_consumidos_este_mes` | kWh consumidos en el mes actual |
| `sensor.mercedes_trips_consumo_medio_mensual` | Consumo medio en kWh/100km (mes actual) |
| `sensor.mercedes_trips_total_trayectos` | Total de trayectos registrados |
| `sensor.mercedes_trips_ultimo_trayecto` | Descripción del último trayecto con atributos completos |
| `sensor.mercedes_trips_trayecto_en_curso` | `active` / `idle` con datos del trayecto activo |

---

## REST API

La integración expone un endpoint interno para consultar trayectos:

```
GET /api/mercedes_trips/trips
```

**Parámetros opcionales:**

| Parámetro | Tipo | Descripción |
|---|---|---|
| `start_date` | `YYYY-MM-DD` | Filtrar desde esta fecha |
| `end_date` | `YYYY-MM-DD` | Filtrar hasta esta fecha |
| `hour_start` | `0–23` | Hora de inicio mínima |
| `hour_end` | `0–23` | Hora de inicio máxima |
| `limit` | int | Máximo de resultados (por defecto 200) |
| `offset` | int | Paginación |

**Ejemplo:**
```bash
curl -H "Authorization: Bearer TU_TOKEN" \
  "http://homeassistant.local:8123/api/mercedes_trips/trips?start_date=2026-07-01&limit=10"
```

**Respuesta:**
```json
{
  "trips": [
    {
      "id": 1,
      "start_time": "2026-07-12T10:00:00",
      "end_time": "2026-07-12T10:23:00",
      "distance_km": 15.4,
      "kwh_used": 3.2,
      "avg_kwh_per_100km": 20.8,
      "start_address": "Calle Mayor 1, Algeciras",
      "end_address": "Av. Principal 5, La Línea",
      "waypoints": [[36.13, -5.45, "2026-07-12T10:00:00"], ...]
    }
  ],
  "stats": {
    "distance_this_month": 342.5,
    "kwh_this_month": 71.3,
    "avg_kwh_per_100km": 20.8,
    "total_trips": 28
  }
}
```

---

## Base de datos

Los trayectos se guardan en `/config/mercedes_trips.db` (SQLite). Puedes consultarla directamente:

```bash
sqlite3 /config/mercedes_trips.db "SELECT start_time, distance_km, kwh_used, start_address, end_address FROM trips ORDER BY start_time DESC LIMIT 10;"
```

---

## Capacidades de batería por modelo

| Modelo | kWh útiles |
|---|---|
| EQA 250 / 250+ / 300 / 350 | 66.5 kWh |
| EQB 250 / 300 / 350 | 66.5 kWh |
| EQC 400 | 80.0 kWh |
| GLC 300e PHEV | 17.6 kWh |
| Clase C 300e PHEV | 17.6 kWh |
| EQE 300 / 350 / 500 | 90.6 kWh |
| EQS 450 / 580 | 107.8 kWh |

---

## Solución de problemas

**No aparecen trayectos:**
- Comprueba que el odómetro cambia de valor en `Developer Tools > States`
- Revisa los logs: `Ajustes → Sistema → Registros` y filtra por `mercedes_trips`

**La card no aparece:**
- Recarga la página con Ctrl+Shift+R (limpia caché del navegador)
- Verifica que el recurso `/mercedes_trips/mercedes-trips-card.js` está en `Ajustes → Dashboards → Recursos`

**El consumo no se calcula:**
- Comprueba que el sensor de SoC no está en `unknown` mientras el coche conduce
- Ajusta la capacidad de batería en las opciones de la integración

---

## Contribuir

Issues y PRs bienvenidos en [github.com/dortizesquivel/mercedes-logbook](https://github.com/dortizesquivel/mercedes-logbook).

---

## Licencia

MIT
