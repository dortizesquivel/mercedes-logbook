# Roadmap

What the project plans to do over the next year, until the end of 2027, and what it won't do. Plans move with what people use the logbook for: vote and propose in [Discussions](https://github.com/dortizesquivel/mercedes-logbook/discussions).

## Planned

- **Several cars in one Home Assistant**: one logbook per car, and a card that shows one car or all of them.
- **Miles in the card**: distances and consumption in the unit the Home Assistant user prefers, as the sensors already do.
- **Exporting trips**: CSV for expenses and mileage claims, GPX for the routes, from the card and the API.
- **An option to keep the trips API to admins**: today every signed-in user can read every trip; some households will want that narrower.
- **Charging sessions**, if mbapi2020 exposes enough: when and where the car charged, and how much.
- **More languages** for the integration and the card, from people who use them.
- **Upkeep**: keep up with Home Assistant and mbapi2020 releases, keep Leaflet and the test dependencies current, and keep the OpenSSF Scorecard checks. Register for the OpenSSF Best Practices badge.

## Not planned

- **A cloud service, accounts or telemetry**: the trips stay in your Home Assistant; that stays. The only outside services are Nominatim, for addresses, and OpenStreetMap's map tiles.
- **Talking to Mercedes directly**: mbapi2020 does that, and does it well. Mercedes Logbook builds on its entities.
- **Platforms other than Home Assistant**.
- **Controlling the car**: no locking, climate or charging commands; the logbook only reads.

## Done

See the [changelog](CHANGELOG.md) and the [releases](https://github.com/dortizesquivel/mercedes-logbook/releases).
