# Contributing

Thanks for helping. Bug reports, ideas and pull requests are welcome. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md); how decisions are made is in [GOVERNANCE.md](GOVERNANCE.md).

## Reporting

- **Bugs**: open an [issue](https://github.com/dortizesquivel/mercedes-logbook/issues/new/choose) with the bug form. It asks for the versions of Mercedes Trips, Home Assistant and mbapi2020, your car and the logs filtered by `mercedes_trips`. Trips are location history: remove addresses, coordinates, your VIN and your licence plate before you paste anything.
- **Ideas**: propose them, or vote with a 👍 on the ones you want, in [Discussions → Ideas](https://github.com/dortizesquivel/mercedes-logbook/discussions/categories/ideas). Questions go to [Q&A](https://github.com/dortizesquivel/mercedes-logbook/discussions/categories/q-a).
- **Security problems**: don't open an issue; report them privately as [SECURITY.md](SECURITY.md) explains.

## Pull requests

`main` is protected: every change goes in through a pull request. A pull request is merged when:

- **The CI passes.** That covers ruff, the translations check, the Python tests with their coverage floor and the Hypothesis fuzzing; the `npm audit` and the integrity check of the vendored Leaflet, ESLint with no warnings and the browser tests of the card; the HACS validation, hassfest and CodeQL.
- **New functionality comes with tests.** A new option or behaviour in the integration gets tests in `tests/` (pytest, with `pytest-homeassistant-custom-component`); if it changes the card, a browser test in `test/browser/` (Playwright, against `test/demo.html`). A bug fix gets a test that fails without it. Code that reads input from entity states, the API's query parameters or Nominatim should also be covered by the Hypothesis property-based tests.
- **The docs follow the change.** The README describes every setting, sensor, API parameter and card feature. If the card's look changes, update the images in `docs/`, made from `test/demo.html`.

## Style

- Match the code around you: small functions, comments that say why rather than what. Python follows Home Assistant's conventions (async, executor jobs for blocking work such as SQLite); the card is a plain custom element, no framework and no build step.
- `ruff check .` and `npm run lint` must pass with no warnings.
- User-visible text is in English and Spanish: the integration's in `translations/en.json` and `translations/es.json` (`python scripts/check_translations.py` checks they have the same keys), the card's in its `STRINGS` table.
- Keep it light. New dependencies need a good reason: the integration has no Python requirements of its own, and the card's only one is Leaflet, vendored in `frontend/vendor/`.
- Text from outside, such as addresses from Nominatim or anything from an entity state, is escaped before it goes into the card's markup; queries to the database use parameters, never string formatting of input.

## Sign-off (DCO)

Every commit in a pull request certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change or otherwise have the right to submit it under the project's licence. Sign it off with `git commit -s`, which adds a line like:

```
Signed-off-by: Your Name <you@example.com>
```

## Running it

See [Development](README.md#development) in the README: `pip install -r requirements_test.txt`, `ruff check .` and `pytest` for the integration; `npm ci`, `npm run lint`, `npm test` and `npm run demo` for the card.

Contributions are released under the project's [MIT licence](LICENSE).
