# Governance

Mercedes Trips is a small open source project with one maintainer. This page says who decides what, how, and what happens if the maintainer is gone.

## Roles

- **Maintainer**: [@dortizesquivel](https://github.com/dortizesquivel), the project's author. Reviews and merges pull requests, triages issues and discussions, decides the roadmap, cuts releases, answers security reports ([SECURITY.md](SECURITY.md)) and enforces the [code of conduct](CODE_OF_CONDUCT.md). Holds the repository's admin rights and its secrets (the deploy key used by the release workflow).
- **Contributors**: anyone who opens an issue, a discussion or a pull request. Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md), including the sign-off described there.
- **Users**: vote on ideas and polls in [Discussions](https://github.com/dortizesquivel/mercedes-logbook/discussions); those votes weigh on the roadmap.

## Decisions

- **Day-to-day changes** go through pull requests. A pull request is merged when the CI passes (lint, Python and browser tests, fuzzing, the Leaflet audit, HACS validation, hassfest, CodeQL) and the maintainer accepts it.
- **Features and direction** are discussed in the open, in issues and Discussions. The maintainer decides, guided by votes and by the [roadmap](ROADMAP.md), and explains the decision when it says no.
- **Security reports** are handled privately, as SECURITY.md describes, and published as an advisory once fixed.
- **Releases** are cut by the maintainer with the release workflow, which tests, signs and publishes them; nobody uploads release files by hand.

## Becoming a maintainer

Someone who has contributed substantially and steadily, through several merged pull requests or reviews, can be invited to become a co-maintainer. The invitation comes from the existing maintainers. Co-maintainers get write access first and admin access after a while. With two or more maintainers, a pull request also needs the approval of a maintainer who didn't write it.

## Continuity

If the maintainer stops being available:

- Everything needed to keep the project going lives in the repository: the source, the tests, the docs and the workflows that test, sign and publish releases. Releases are signed through GitHub's OIDC, so there are no signing keys to hand over; the only secret is the deploy key (`DEPLOY_KEY`), which a new owner can replace.
- The maintainer plans to designate a successor on GitHub ([account successor](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/maintaining-ownership-continuity-of-your-personal-accounts-repositories)), who could then take over the repository, its issues and its releases. Until then, the way to continue is a fork.
- The code is MIT licensed, so anyone can fork it and carry on; HACS users can switch to a fork by adding it as a custom repository. The trips stay in each user's own `/config/mercedes_trips.db`, so a fork that keeps the database format keeps everyone's history.

## Changing this document

Changes to governance go through a pull request like any other change, and are announced in Discussions.
