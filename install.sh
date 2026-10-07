#!/usr/bin/env bash
# One-shot installer. ./install.sh does everything; ./install.sh --pick asks.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MANAGE=(python3 "$HERE/manage.py")
TUI=(python3 "$HERE/scripts/tui.py")

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (stdlib only)." >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Claude Code token saver — individual opt-in

  ./install.sh                         Set up everything, no questions: files, mod, recommended
                                       modules, preflight against your existing hooks. Run once.
  ./install.sh --dry-run               Show what the one-shot would change
  ./install.sh --no-mod                One-shot without the in-process mod (Python hooks only)
  ./install.sh --plain                 One-shot without the spinning coin (CI, logs)
  ./install.sh --demo                  Watch the install experience without changing anything
  ./install.sh --pick                  Interactive module picker instead
  ./install.sh --list                  Show modules and what is on
  ./install.sh --enable rules,skill,quiet-bash
  ./install.sh --disable trim-output
  ./install.sh --recommended           Enable the safe default set
  ./install.sh --files-only            Copy files, enable nothing
  ./install.sh --uninstall             Remove our hooks/rules/skill; leave your other settings
  ./install.sh --project               Scope to this repo only (.claude/settings.local.json)
  ./install.sh --enable statusline,quiet-map

Dashboard / bench
  ./install.sh dash                    Free: tokens from your local Claude Code sessions
  ./install.sh dash --watch            Refresh every 2s
  ./install.sh bench                   Free: local hook bench (used / saved / result)
  ./install.sh bench --live            A/B against Claude (asks first; spends tokens)

Skills (each one costs tokens every turn)
  ./install.sh skills                  What is active, parked, linked; unused marks
  ./install.sh skills pick             Interactive: choose what to park
  ./install.sh skills park gsap-*      Park by name, glob, @group, or 'unused'
  ./install.sh skills unpark <name>    Bring back everywhere
  ./install.sh skills link <name>      Bring back for this repo only

Default scope is you: ~/.claude/  (follows you across every repo on this machine)
EOF
}

SCOPE=(--scope user)
CMD=""
MODULES=""
SETUP_ARGS=()
TUI_CMD=""
TUI_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --pick|--interactive) CMD=interactive; shift ;;
    --dry-run) CMD=setup; SETUP_ARGS+=(--dry-run); shift ;;
    --no-mod) CMD=setup; SETUP_ARGS+=(--no-mod); shift ;;
    --plain) CMD=setup; SETUP_ARGS+=(--plain); shift ;;
    --demo) exec python3 "$HERE/scripts/coin.py" --demo --seconds 12 ;;
    --list|-l) CMD=status; shift ;;
    --status) CMD=status; shift ;;
    --enable) CMD=enable; MODULES="${2:-}"; shift 2 ;;
    --disable) CMD=disable; MODULES="${2:-}"; shift 2 ;;
    --recommended) CMD=recommended; shift ;;
    --files-only|--install) CMD=install; shift ;;
    --uninstall) CMD=uninstall; shift ;;
    --project) SCOPE=(--scope project); shift ;;
    --project-dir) SCOPE=(--scope project --project "$2"); shift 2 ;;
    dash|bench) TUI_CMD="$1"; shift; TUI_ARGS+=("$@"); break ;;
    skills) shift; exec python3 "$HERE/plugins/token-saver/scripts/skills.py" "$@" ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -n "$TUI_CMD" ]]; then
  exec "${TUI[@]}" "$TUI_CMD" "${TUI_ARGS[@]}"
fi

if [[ -z "$CMD" || "$CMD" == "setup" ]]; then
  # ${arr[@]+...} keeps bash 3.2 (macOS) happy under set -u when the array is empty
  exec "${MANAGE[@]}" "${SCOPE[@]}" setup ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
fi

if [[ "$CMD" == "enable" || "$CMD" == "disable" ]]; then
  if [[ -z "$MODULES" ]]; then
    echo "--$CMD needs a comma-separated module list" >&2
    exit 2
  fi
  exec "${MANAGE[@]}" "${SCOPE[@]}" "$CMD" "$MODULES"
fi

exec "${MANAGE[@]}" "${SCOPE[@]}" "$CMD"

