#!/usr/bin/env bash
# Build dist/claude-token-saver.zip from a whitelist. No previews, caches, tests' scratch or local launch config.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
VERSION="$(python3 -c 'import json;print(json.load(open("plugins/token-saver/.claude-plugin/plugin.json"))["version"])')"
OUT="dist/claude-token-saver-${VERSION}.zip"
mkdir -p dist
rm -f "$OUT" dist/claude-token-saver.zip
python3 scripts/test_skills.py >/dev/null
claude plugin validate ./plugins/token-saver >/dev/null 2>&1 || echo "warn: claude plugin validate did not pass or claude is missing; shipping anyway" >&2
zip -q -r "$OUT" \
  README.md INSTALL-FOR-CLAUDE.md install.sh manage.py modules.json quiet.json thresholds.json CLAUDE.md.snippet .gitignore \
  .claude-plugin .claude/hooks .claude/rules .claude/skills .claude/settings.json \
  plugins/token-saver scripts \
  -x '*/__pycache__/*' '*.pyc' '*/.DS_Store' '.preview/*' 'scripts/dist.sh'
ln -sf "$(basename "$OUT")" dist/claude-token-saver.zip
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1
