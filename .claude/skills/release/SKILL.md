---
name: release
description: Ship a new version of the token-saver mod to this machine and to the zip. Use after a change to plugins/token-saver passes its tests, when the user says "install it", "bump", "release", "ship", or asks why Claude still shows the old pane.
---

# Release the mod

Versions live in two files and must match: `plugins/token-saver/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Claude installs from a staged copy at `~/.claude/token-saver/pack`, not from this checkout, so an edit here is invisible until staged.

## Steps

1. Tests green: `cd plugins/token-saver && claude plugin test . | grep -E "\(fail\)| pass$| fail$"`.
2. Bump the patch version in both files (one `sed`, both paths).
3. Stage and refresh the installed plugin from the repo root:

```bash
python3 -I -c "import sys; sys.path.insert(0,'.'); import manage; from pathlib import Path; print(manage.install_mod(Path.home()/'.claude'/'token-saver'))"
```

4. Pull the new version into the plugin cache:

```bash
claude plugin update token-saver@token-saver
```

5. Tell the user in one line: version, and that it loads after a restart (or `/reload-plugins` in a terminal session).

Do not run `manage.py install` for this: it resets the enabled-modules list. For the zip others install from, `scripts/dist.sh` (runs the self-test, validates the mod, writes `dist/`).

## Commit

Only when asked. One commit per release, message in the repo's voice: what changed for the person, not the code.
