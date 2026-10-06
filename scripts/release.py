"""Release helpers used by .github/workflows/release.yml.

    python scripts/release.py bump patch|minor|major   → bumps manifest.json, prints vX.Y.Z
    python scripts/release.py notes vX.Y.Z [--dry-run] → release-notes.md + CHANGELOG.md

Notes come from the commit subjects since the previous v* tag. --dry-run
only prints them.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "custom_components" / "mercedes_trips" / "manifest.json"
CHANGELOG = ROOT / "CHANGELOG.md"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()


def bump(part: str) -> str:
    text = MANIFEST.read_text()
    current = json.loads(text)["version"]
    major, minor, patch = (int(n) for n in current.split("."))
    if part == "major":
        major, minor, patch = major + 1, 0, 0
    elif part == "minor":
        minor, patch = minor + 1, 0
    elif part == "patch":
        patch += 1
    else:
        sys.exit(f"Unknown bump: {part}")
    new = f"{major}.{minor}.{patch}"
    # Only the version line changes, so the file keeps its hand formatting.
    MANIFEST.write_text(re.sub(r'("version":\s*")[^"]+(")', rf"\g<1>{new}\g<2>", text, count=1))
    return f"v{new}"


def notes(tag: str, dry_run: bool) -> None:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        sys.exit("Usage: release.py notes vX.Y.Z [--dry-run]")
    try:
        prev = git("describe", "--tags", "--abbrev=0", "--match", "v*")
    except subprocess.CalledProcessError:
        prev = ""  # first release
    log = git("log", "--no-merges", "--pretty=%s%x09%h", f"{prev}..HEAD" if prev else "HEAD")
    changes = [
        f"- {subject} ({sha})"
        for subject, sha in (line.split("\t") for line in log.splitlines() if line)
        if not subject.startswith("chore(release)")
    ] or ["- Maintenance release"]

    repo = os.environ.get("GITHUB_REPOSITORY", "dortizesquivel/mercedes-logbook")
    compare = f"\n\n**Full changelog:** https://github.com/{repo}/compare/{prev}...{tag}" if prev else ""
    body = "## Changes\n\n" + "\n".join(changes) + compare + "\n"

    if dry_run:
        print(f"--- release notes ({prev or 'no previous tag'} → {tag}) ---\n{body}")
        return

    (ROOT / "release-notes.md").write_text(body)
    section = f"## {tag} - {date.today().isoformat()}\n\n" + "\n".join(changes) + "\n\n"
    old = CHANGELOG.read_text() if CHANGELOG.exists() else "# Changelog\n\n"
    # New section goes above the newest existing one, below the intro.
    at = old.find("\n## ")
    CHANGELOG.write_text(old + "\n" + section if at == -1 else old[: at + 1] + section + old[at + 1 :])
    print(body)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "bump":
        print(bump(sys.argv[2]))
    elif len(sys.argv) >= 3 and sys.argv[1] == "notes":
        notes(sys.argv[2], "--dry-run" in sys.argv)
    else:
        sys.exit(__doc__)
