"""Fail if any translation file is missing a key another one has."""
import json
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "custom_components" / "mercedes_trips" / "translations"


def keys(node, prefix=""):
    if not isinstance(node, dict):
        return {prefix.rstrip(".")}
    return set().union(*(keys(v, f"{prefix}{k}.") for k, v in node.items()))


files = sorted(DIR.glob("*.json"))
found = {f.name: keys(json.loads(f.read_text(encoding="utf-8"))) for f in files}
everything = set().union(*found.values())
ok = True
for name, have in found.items():
    if missing := sorted(everything - have):
        ok = False
        print(f"{name} is missing: {', '.join(missing)}")
print("translations OK" if ok else "")
sys.exit(0 if ok else 1)
