# Releases, upgrades and security

What you can rely on when you install and upgrade AgentX: how often it is released, what an upgrade may change, how each release is checked, and how fast a security report gets an answer.

## How often it is released

AgentX is released from `main` whenever a fix or a feature lands there, often several times a day: 35 releases from 18 to 25 October 2026. Each release is a new version on npm (`agentix-cli`) with a GitHub release and an entry in [CHANGELOG.md](https://github.com/anis-marrouchi/agentx/blob/main/CHANGELOG.md). The version number follows [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

There is one supported line: the latest release. There are no long-term branches; you get a fix by upgrading.

## Upgrade promise

Your `agentx.json`, your commands and your scripts keep working when you upgrade, unless the changelog says otherwise first.

- **A breaking change is always announced.** A breaking change removes or renames a command, a flag or a setting, or makes a valid `agentx.json` invalid. It is listed under **⚠ BREAKING CHANGES** in the changelog, with what to do when you upgrade.
- **From 1.0, only a major version breaks.** From version 1.0.0 on, a breaking change comes only with a new major version (2.0.0, 3.0.0, …). Until then, while AgentX is in 0.x, a breaking change raises the minor version (0.169.0 → 0.170.0), and patch releases never break.
- **It is checked on every pull request.** The docs check (`gate` in CI) compares the commands, flags and settings before and after each change. A pull request that removes one fails unless its title is marked with `!` and its description has a `BREAKING CHANGE:` line saying what to do. That line becomes the upgrade note in the changelog. A change the check cannot see, such as a stricter rule for a value, is marked the same way by whoever makes it, and reviewers ask for it.

Before you upgrade, read the changelog entries since your version for **⚠ BREAKING CHANGES**.

## Install matrix

Each release is installed in every supported way, on Linux and macOS, by the **Install matrix** workflow:

| Way | Linux | macOS |
|---|---|---|
| `npm install agentix-cli` | ✓ | ✓ |
| `install.sh` (the README's one-line install, with no Node needed) | ✓ | ✓ |
| Docker (`docker compose up --build`) | ✓ | — (macOS build machines have no Docker) |

It runs after each release, every Monday against the latest release, and on pull requests that change an install path. A run passes when every way installs and starts. The **install matrix** badge at the top of the README shows how many of the last 20 runs passed; each run, with its log, is under **Actions › Install matrix** on GitHub.

Windows is not tested; use WSL or Docker.

## Security reports

Report a vulnerability privately, never in a public issue: use [GitHub private vulnerability reporting](https://github.com/anis-marrouchi/agentx/security/advisories/new), or email the maintainer as described in [SECURITY.md](https://github.com/anis-marrouchi/agentx/blob/main/SECURITY.md).

- **The maintainer aims to confirm within 48 hours** that the report was received.
- Security fixes ship in a release of the supported line, the latest one. There are no long-term branches to patch.

## Roadmap

What is being built now and next, and what was done, is on the [Roadmap](../roadmap.md) page.

## Check it worked

1. **Terminal:** run `agentx --version` and compare it with the newest version in [CHANGELOG.md](https://github.com/anis-marrouchi/agentx/blob/main/CHANGELOG.md).
2. **Browser:** open the README on GitHub. The **install matrix** badge shows the pass rate of the last runs.
3. Before an upgrade, search the changelog between your version and the new one for **BREAKING CHANGES**.

## If something is wrong

- **An upgrade broke your setup and the changelog said nothing:** that breaks the promise above. Open an issue with your old and new version and the error, and go back to the old version with `npm install -g agentix-cli@<old version>` until it is fixed.
- **The install matrix badge is red:** open **Actions › Install matrix** on GitHub to see which way failed for which version. The other ways still work; [Install](../install.md) lists them.
- **The badge says "no runs yet" or does not load:** the first run after a release creates it. Check again after the next release.
- **No answer to a security report after 48 hours:** send it again by email, as [SECURITY.md](https://github.com/anis-marrouchi/agentx/blob/main/SECURITY.md) says.
