#!/usr/bin/env python3
"""Opt-in manager for the Claude Code token-saver pack.

Copies files into ~/.claude/token-saver/ (or a project overlay) and
splices only the modules you enable into settings.json.
Never overwrites someone else's hooks.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

MARKER = "token-saver/"
PACK_ROOT = Path(__file__).resolve().parent
MODULES_FILE = PACK_ROOT / "modules.json"
SETTINGS_KEYS_OWNED = {
    "enableArtifact",
    "bashOutputMaxChars",
    "disableClaudeAiConnectors",
    "disableRemoteControl",
}
ENV_KEYS_OWNED = {
    "BASH_MAX_OUTPUT_LENGTH",
    "MAX_THINKING_TOKENS",
    "CLAUDE_CODE_DISABLE_ARTIFACT",
}


def load_catalog() -> list[dict]:
    data = json.loads(MODULES_FILE.read_text(encoding="utf-8"))
    return data["modules"]


def by_id(catalog: list[dict]) -> dict[str, dict]:
    return {m["id"]: m for m in catalog}


def home_dir() -> Path:
    return Path.home() / ".claude"


def dest_for(scope: str, project: Path | None) -> tuple[Path, Path]:
    """Return (files_root, settings_path)."""
    if scope == "project":
        root = (project or Path.cwd()).resolve()
        files = root / ".claude" / "token-saver"
        settings = root / ".claude" / "settings.local.json"
        return files, settings
    files = home_dir() / "token-saver"
    settings = home_dir() / "settings.json"
    return files, settings


def state_path(files_root: Path) -> Path:
    return files_root / "enabled.json"


def read_json(path: Path, default):
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def backup(path: Path) -> Path | None:
    if not path.is_file():
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = path.with_name(path.name + f".bak-{stamp}")
    shutil.copy2(path, dest)
    return dest


def copy_pack_files(files_root: Path) -> None:
    hooks_src = PACK_ROOT / ".claude" / "hooks"
    hooks_dst = files_root / "hooks"
    hooks_dst.mkdir(parents=True, exist_ok=True)
    for src in hooks_src.glob("*.py"):
        shutil.copy2(src, hooks_dst / src.name)
        (hooks_dst / src.name).chmod(0o755)
    shutil.copy2(PACK_ROOT / "modules.json", files_root / "modules.json")
    snippet = PACK_ROOT / "CLAUDE.md.snippet"
    if snippet.is_file():
        shutil.copy2(snippet, files_root / "CLAUDE.md.snippet")
    scripts_src = PACK_ROOT / "scripts"
    scripts_dst = files_root / "scripts"
    scripts_dst.mkdir(parents=True, exist_ok=True)
    for name in ("tui.py", "token-audit.py", "selftest.py", "statusline.py"):
        src = scripts_src / name
        if src.is_file():
            shutil.copy2(src, scripts_dst / name)
            (scripts_dst / name).chmod(0o755)
    real_skills = PACK_ROOT / "plugins" / "token-saver" / "scripts" / "skills.py"
    if real_skills.is_file():
        shutil.copy2(real_skills, scripts_dst / "skills.py")
        (scripts_dst / "skills.py").chmod(0o755)
    for name in ("quiet.json", "thresholds.json"):
        src = PACK_ROOT / name
        dst = files_root / name
        if src.is_file() and not dst.is_file():
            shutil.copy2(src, dst)


def hook_command(files_root: Path, script: str) -> str:
    # Absolute path so user-scope hooks work in every repo.
    return f'python3 "{files_root / "hooks" / script}"'


def is_ours(entry: dict, files_root: Path) -> bool:
    cmd = ""
    hooks = entry.get("hooks") or []
    if hooks and isinstance(hooks[0], dict):
        cmd = str(hooks[0].get("command") or "")
    return MARKER in cmd or str(files_root) in cmd


def strip_our_hooks(settings: dict, files_root: Path) -> dict:
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return settings
    cleaned = {}
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            cleaned[event] = groups
            continue
        kept = [g for g in groups if not (isinstance(g, dict) and is_ours(g, files_root))]
        if kept:
            cleaned[event] = kept
    if cleaned:
        settings["hooks"] = cleaned
    elif "hooks" in settings:
        del settings["hooks"]
    return settings


def add_hook(settings: dict, mod: dict, files_root: Path) -> None:
    event = mod["event"]
    group = {
        "hooks": [
            {
                "type": "command",
                "command": hook_command(files_root, mod["script"]),
                "timeout": int(mod.get("timeout") or 5),
            }
        ]
    }
    matcher = (mod.get("matcher") or "").strip()
    if matcher:
        group["matcher"] = matcher
    settings.setdefault("hooks", {}).setdefault(event, []).append(group)


def apply_settings_module(settings: dict, mod: dict, enable: bool) -> None:
    payload = mod.get("settings") or {}
    if enable:
        for k, v in payload.items():
            if k == "env" and isinstance(v, dict):
                settings.setdefault("env", {}).update(v)
            else:
                settings[k] = v
        for rule in mod.get("deny") or []:
            deny = settings.setdefault("permissions", {}).setdefault("deny", [])
            if rule not in deny:
                deny.append(rule)
        return
    # disable
    for k, v in payload.items():
        if k == "env" and isinstance(v, dict):
            env = settings.get("env") or {}
            for ek in v:
                env.pop(ek, None)
            if env:
                settings["env"] = env
            elif "env" in settings:
                del settings["env"]
        elif k in SETTINGS_KEYS_OWNED:
            settings.pop(k, None)
    if mod.get("deny"):
        deny = (settings.get("permissions") or {}).get("deny") or []
        leftover = [r for r in deny if r not in set(mod["deny"])]
        if leftover:
            settings.setdefault("permissions", {})["deny"] = leftover
        else:
            perms = settings.get("permissions") or {}
            perms.pop("deny", None)
            if perms:
                settings["permissions"] = perms
            elif "permissions" in settings:
                del settings["permissions"]


def install_files_module(mod: dict, scope: str, project: Path | None, enable: bool) -> None:
    if scope == "project":
        root = (project or Path.cwd()).resolve() / ".claude"
    else:
        root = home_dir()
    if mod["id"] == "rules":
        dest = root / "rules" / "token-budget.md"
        src = PACK_ROOT / ".claude" / "rules" / "token-budget.md"
        if enable:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        elif dest.is_file():
            dest.unlink()
    elif mod["id"] == "skill":
        for skill_name in ("token-saver", "repo-skills"):
            dest_dir = root / "skills" / skill_name
            src = PACK_ROOT / ".claude" / "skills" / skill_name / "SKILL.md"
            if enable:
                if not src.is_file():
                    continue
                dest_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest_dir / "SKILL.md")
            else:
                skill = dest_dir / "SKILL.md"
                if skill.is_file():
                    skill.unlink()
                try:
                    dest_dir.rmdir()
                except OSError:
                    pass
    elif mod["id"] == "quiet-map":
        dest = (Path.home() / ".claude" / "token-saver" / "quiet.json") if scope != "project" else root / "token-saver" / "quiet.json"
        src = PACK_ROOT / "quiet.json"
        if enable and src.is_file() and not dest.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        # never delete user edits on disable
    elif mod["id"] == "statusline":
        # settings splice happens in apply_statusline
        pass


def statusline_command(files_root: Path) -> str:
    return f'python3 "{files_root / "scripts" / "statusline.py"}"'


def is_our_statusline(settings: dict, files_root: Path) -> bool:
    sl = settings.get("statusLine")
    if not isinstance(sl, dict):
        return False
    cmd = str(sl.get("command") or "")
    return "token-saver/statusline" in cmd or "token-saver/scripts/statusline" in cmd or str(files_root / "scripts" / "statusline.py") in cmd


def apply_statusline(settings: dict, files_root: Path, enable: bool) -> str | None:
    """Returns a warning to print, if any."""
    if enable:
        if "statusLine" in settings and not is_our_statusline(settings, files_root):
            return (
                "statusLine already set — left it alone. To use ours, chain:\n"
                f'  python3 "{files_root / "scripts" / "statusline.py"}" && your-existing-command'
            )
        settings["statusLine"] = {
            "type": "command",
            "command": statusline_command(files_root),
            "refreshInterval": 30,
        }
        return None
    if is_our_statusline(settings, files_root):
        settings.pop("statusLine", None)
    return None


def rebuild_settings(settings: dict, enabled: list[str], catalog: list[dict], files_root: Path) -> dict:
    settings = strip_our_hooks(settings, files_root)
    index = by_id(catalog)
    enabled_set = set(enabled)
    for mod in catalog:
        if mod["kind"] == "settings" and mod["id"] not in enabled_set:
            apply_settings_module(settings, mod, enable=False)
        if mod["kind"] == "statusline" and mod["id"] not in enabled_set:
            apply_statusline(settings, files_root, enable=False)
    warn = None
    for mid in enabled:
        mod = index[mid]
        if mod["kind"] == "hook":
            add_hook(settings, mod, files_root)
        elif mod["kind"] == "settings":
            apply_settings_module(settings, mod, enable=True)
        elif mod["kind"] == "statusline":
            warn = apply_statusline(settings, files_root, enable=True)
    if warn:
        print(warn)
    return settings


def sync(scope: str, project: Path | None, enabled: list[str], catalog: list[dict]) -> None:
    files_root, settings_path = dest_for(scope, project)
    copy_pack_files(files_root)
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    existing = read_json(settings_path, {})
    if settings_path.is_file() and not list(files_root.glob("*.bak-*")):
        backup(settings_path)
    elif settings_path.is_file():
        backup(settings_path)
    rebuilt = rebuild_settings(existing, enabled, catalog, files_root)
    write_json(settings_path, rebuilt)
    write_json(
        state_path(files_root),
        {"scope": scope, "enabled": enabled, "updated": datetime.now().isoformat(timespec="seconds")},
    )
    for mid in {m["id"] for m in catalog if m["kind"] in {"rules", "skill", "files", "statusline"}}:
        install_files_module(by_id(catalog)[mid], scope, project, mid in set(enabled))


def current_enabled(files_root: Path) -> list[str]:
    return list(read_json(state_path(files_root), {}).get("enabled") or [])


def mod_rewrite_enabled() -> bool:
    """True if the token-saver mod is installed and not explicitly disabled."""
    home = Path.home() / ".claude"
    settings = read_json(home / "settings.json", {})
    enabled = settings.get("enabledPlugins") or settings.get("plugins") or {}
    if isinstance(enabled, dict):
        for key, val in enabled.items():
            if "token-saver" in str(key) and val is not False:
                return True
    if isinstance(enabled, list) and any("token-saver" in str(x) for x in enabled):
        return True
    for path in (
        home / "plugins" / "installed_plugins.json",
        home / "plugins" / "known_marketplaces.json",
    ):
        blob = ""
        if path.is_file():
            blob = path.read_text(encoding="utf-8", errors="replace")
        if "token-saver" in blob and "quiet" in blob:
            return True
    return False


# ---------- summary output ----------

def tilde(path) -> str:
    text = str(path)
    home = str(Path.home())
    return "~" + text[len(home):] if text.startswith(home) else text


def _row(label: str, value: str) -> str:
    return f"  {label:<10} {value}"


def summary(settings_path: Path, files_root: Path, enabled: list[str], notes: list[str], mod_note: str | None,
            foreign: dict[str, list[tuple[str, str]]], dry_run: bool = False, after_steps: bool = False) -> None:
    """Short, aligned, one fact per line. Notes are already one short clause each.
    after_steps: the coin's step list already showed files, mod and modules; print only the rest."""
    print()
    if not after_steps:
        print("token-saver  " + ("dry run, nothing written" if dry_run else "set up"))
        if mod_note:
            print(_row("mod", mod_note))
        print(_row("on", " · ".join(enabled) if enabled else "(nothing)"))
    for n in notes:
        label, _, rest = n.partition(": ")
        is_off = rest.startswith("off, ")
        print(_row("off" if is_off else "note", f"{label} — {rest[len('off, '):] if is_off else rest}"))
    if foreign:
        kept = " · ".join(f"{ev} {cmd}" for ev, rows in foreign.items() for _, cmd in rows)
        print(_row("yours", f"{kept}  (kept, untouched)"))
    print(_row("settings", tilde(settings_path)))
    print()
    print("  next       open a new Claude Code session, or /clear" if not dry_run else "  next       ./install.sh to apply")


# ---------- preflight: coexist with hooks the engineer already has ----------

# What the in-process mod already does; the Python twins are skipped when it is on.
COVERED_BY_MOD = {"quiet-bash", "trim-output", "compact-keep"}


def _short_cmd(cmd: str) -> str:
    parts = [p for p in cmd.replace('"', " ").split() if "/" in p or p.endswith((".py", ".ts", ".js", ".sh"))]
    return Path(parts[-1]).name if parts else cmd[:40]


def foreign_hooks(settings: dict, files_root: Path) -> dict[str, list[tuple[str, str]]]:
    """event -> [(matcher, short command)] for hooks that are not ours."""
    out: dict[str, list[tuple[str, str]]] = {}
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return out
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for g in groups:
            if not isinstance(g, dict) or is_ours(g, files_root):
                continue
            for h in g.get("hooks") or []:
                if isinstance(h, dict) and h.get("command"):
                    out.setdefault(event, []).append((str(g.get("matcher") or ""), _short_cmd(str(h["command"]))))
    return out


def preflight(enabled: list[str], settings: dict, files_root: Path, mod_on: bool) -> tuple[list[str], list[str]]:
    """Decide what to actually enable next to what is already there. Returns (enabled, notes)."""
    final = list(enabled)
    notes: list[str] = []
    if mod_on:
        for mid in [m for m in final if m in COVERED_BY_MOD]:
            final.remove(mid)
        covered = sorted(set(enabled) & COVERED_BY_MOD)
        if covered:
            notes.append(f"{', '.join(covered)}: off, the mod does these in-process")
    fh = foreign_hooks(settings, files_root)

    def hits(event: str, tool: str) -> list[str]:
        return [cmd for matcher, cmd in fh.get(event, []) if not matcher or matcher == "*" or tool in matcher]

    if "trim-output" in final and hits("PostToolUse", "Bash"):
        notes.append("trim-output: runs after yours, only if output is still over 4k chars")
    if "quiet-bash" in final and hits("PreToolUse", "Bash"):
        notes.append("quiet-bash: runs beside yours; skips quiet flags, pipes, rm, sudo")
    if "session-audit" in final and fh.get("SessionStart"):
        notes.append("session-audit: one line beside your SessionStart hook")
    if "compact-keep" in final and fh.get("PreCompact"):
        notes.append("compact-keep: keep-list beside your PreCompact hook")
    if "cache-guard" in final and fh.get("PreModelSwitch"):
        notes.append("cache-guard: beside your PreModelSwitch hook; stricter answer wins")
    if "statusline" in final and "statusLine" in settings and not is_our_statusline(settings, files_root):
        final.remove("statusline")
        cmd = _short_cmd(str((settings.get("statusLine") or {}).get("command") or ""))
        notes.append(f"statusline: off, you already have one ({cmd})")
    return final, notes


# ---------- the mod: install through the Claude CLI when it is there ----------

def claude_cli() -> str | None:
    return shutil.which("claude")


def _run(cmd: list[str], timeout: int = 120) -> tuple[int, str]:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
    return res.returncode, (res.stdout + "\n" + res.stderr).strip()


def mod_ids() -> tuple[str, str]:
    market = read_json(PACK_ROOT / ".claude-plugin" / "marketplace.json", {}).get("name") or "token-saver"
    plugin = read_json(PACK_ROOT / "plugins" / "token-saver" / ".claude-plugin" / "plugin.json", {}).get("name") or "token-saver"
    return plugin, market


def staged_pack(files_root: Path) -> Path:
    """A copy of the marketplace + plugin under ~/.claude/token-saver/pack, so the download can be deleted."""
    return files_root / "pack"


def stage_pack(files_root: Path) -> Path:
    dest = staged_pack(files_root)
    (dest / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    shutil.copy2(PACK_ROOT / ".claude-plugin" / "marketplace.json", dest / ".claude-plugin" / "marketplace.json")
    plug_src = PACK_ROOT / "plugins" / "token-saver"
    plug_dst = dest / "plugins" / "token-saver"
    if plug_dst.exists():
        shutil.rmtree(plug_dst)
    shutil.copytree(plug_src, plug_dst, ignore=shutil.ignore_patterns("*.test.ts", "__pycache__", ".DS_Store"))
    return dest


def mod_read_from(cli: str) -> str | None:
    """Where Claude reads the installed mod from, or None when it is not installed."""
    plugin, market = mod_ids()
    rc, out = _run([cli, "plugin", "list"], timeout=60)
    if rc != 0 or f"{plugin}@{market}" not in out:
        return None
    block = out.split(f"{plugin}@{market}", 1)[1]
    for line in block.splitlines()[:6]:
        if "Read from:" in line:
            return line.split("Read from:", 1)[1].strip()
    return ""


def mod_installed(cli: str) -> bool:
    return mod_read_from(cli) is not None


def install_mod(files_root: Path, dry_run: bool = False) -> tuple[bool, str]:
    """(mod is on, one-line note). Never raises; a failure falls back to the Python hooks.

    The marketplace is registered from a staged copy under files_root, never from the
    download folder, so the pack can be deleted or moved afterwards. Re-running restages,
    which is how an update reaches Claude. An install that reads from somewhere else
    (an older run, a --plugin-dir experiment) is moved onto the staged copy.
    """
    cli = claude_cli()
    plugin, market = mod_ids()
    spec = f"{plugin}@{market}"
    if not cli:
        return False, "off, no `claude` on PATH (Python hooks cover it)"
    rc, out = _run([cli, "plugin", "validate", str(PACK_ROOT / "plugins" / "token-saver")], timeout=60)
    if rc != 0:
        first = next((l.strip() for l in out.splitlines() if "error" in l.lower() or "✘" in l), out[:120])
        return False, f"off, this build refused it: {first[:70]} (Python hooks instead)"
    staged = staged_pack(files_root)
    current = mod_read_from(cli)
    if dry_run:
        if current is None:
            return True, f"would install {spec}, read from {tilde(staged)}"
        if current and Path(current).resolve() != (staged / "plugins" / "token-saver").resolve():
            return True, f"would move {spec} from {tilde(current)} to {tilde(staged)}"
        return True, f"{spec} already installed, would refresh {tilde(staged)}"
    stage_pack(files_root)
    if current is not None and current and Path(current).resolve() != (staged / "plugins" / "token-saver").resolve():
        _run([cli, "plugin", "uninstall", spec])
        _run([cli, "plugin", "marketplace", "remove", market])
        current = None
    if current is not None:
        _run([cli, "plugin", "marketplace", "update", market])
        return True, f"{spec} refreshed, read from {tilde(staged)}"
    rc, out = _run([cli, "plugin", "marketplace", "add", str(staged)])
    if rc != 0 and "already" in out.lower():
        _run([cli, "plugin", "marketplace", "update", market])
    elif rc != 0:
        return False, f"off, marketplace add failed: {(out.splitlines()[-1] if out else str(rc))[:70]} (Python hooks instead)"
    rc, out = _run([cli, "plugin", "install", spec])
    if rc != 0 and not mod_installed(cli):
        return False, f"off, install failed: {(out.splitlines()[-1] if out else str(rc))[:70]} (Python hooks instead)"
    return True, f"{spec} installed, read from {tilde(staged)}"


def uninstall_mod() -> str | None:
    cli = claude_cli()
    if not cli:
        return None
    plugin, market = mod_ids()
    spec = f"{plugin}@{market}"
    if not mod_installed(cli):
        return None
    rc, out = _run([cli, "plugin", "uninstall", spec])
    _run([cli, "plugin", "marketplace", "remove", market])
    return f"mod: removed {spec}" if rc == 0 else f"mod: could not remove {spec}; run `claude plugin uninstall {spec}`"


def setup(scope: str, project: Path | None, catalog: list[dict], with_mod: bool, dry_run: bool,
          plain: bool = False) -> int:
    """One command, no questions: files, mod, recommended modules, preflight, summary.
    A spinning coin and a step list show progress on a TTY; plain lines elsewhere."""
    sys.path.insert(0, str(PACK_ROOT / "scripts"))
    from coin import Progress  # noqa: E402  (stdlib-only sibling module)

    files_root, settings_path = dest_for(scope, project)
    animate = not plain and not os.environ.get("TOKEN_SAVER_PLAIN")
    with Progress("token-saver" + ("  (dry run)" if dry_run else ""), ["files", "mod", "preflight", "modules"],
                  animate=animate) as ui:
        with ui.step("files") as st:
            if not dry_run:
                copy_pack_files(files_root)
            st.detail = tilde(files_root)
        with ui.step("mod") as st:
            if with_mod and scope == "user":
                mod_on, mod_note = install_mod(files_root, dry_run=dry_run)
            else:
                mod_on, mod_note = False, "off (" + ("--no-mod" if not with_mod else "project scope") + ")"
            if not mod_on and scope == "user":
                mod_on = mod_rewrite_enabled()
            st.detail = mod_note
            st.state = "done" if mod_on else "skip"
        with ui.step("preflight") as st:
            wanted = [m["id"] for m in catalog if m.get("default")]
            for mid in current_enabled(files_root):
                if mid not in wanted:
                    wanted.append(mid)
            settings = read_json(settings_path, {})
            enabled, notes = preflight(wanted, settings, files_root, mod_on)
            kept = foreign_hooks(settings, files_root)
            st.detail = f"{sum(len(v) for v in kept.values())} of your hooks kept" if kept else "no other hooks"
        with ui.step("modules") as st:
            if not dry_run:
                sync(scope, project, enabled, catalog)
            st.detail = " · ".join(enabled) if enabled else "(nothing)"
    summary(settings_path, files_root, enabled, notes, mod_note, kept, dry_run=dry_run, after_steps=True)
    return 0


def parse_ids(raw: str, catalog: list[dict]) -> list[str]:
    index = by_id(catalog)
    ids = [x.strip() for x in raw.split(",") if x.strip()]
    unknown = [i for i in ids if i not in index]
    if unknown:
        raise SystemExit(f"Unknown module(s): {', '.join(unknown)}\nKnown: {', '.join(index)}")
    return ids


def print_status(scope: str, project: Path | None, catalog: list[dict]) -> None:
    files_root, settings_path = dest_for(scope, project)
    enabled = set(current_enabled(files_root))
    print(f"scope     {scope}")
    print(f"files     {files_root}")
    print(f"settings  {settings_path}")
    print()
    width = max(len(m["id"]) for m in catalog)
    for m in catalog:
        flag = "ON " if m["id"] in enabled else "off"
        print(f"  [{flag}]  {m['id']:<{width}}  {m['summary']}")
    if not enabled:
        print("\nNothing enabled. Example:")
        print(f"  python3 {PACK_ROOT / 'manage.py'} enable rules,skill,quiet-bash")


def interactive(scope: str, project: Path | None, catalog: list[dict]) -> list[str]:
    files_root, _ = dest_for(scope, project)
    already = set(current_enabled(files_root))
    print("Claude Code token saver — pick modules to enable")
    print("Nothing is forced. Enter numbers separated by space, or press Enter for recommended.\n")
    recommended = [m["id"] for m in catalog if m.get("default")]
    for i, m in enumerate(catalog, 1):
        mark = "*" if m["id"] in already else ("+" if m.get("default") else " ")
        print(f"  {i:2}. [{mark}] {m['id']:<16} {m['summary']}")
    print("\n  * already on    + recommended    blank = off by default")
    raw = input("\nEnable which? [recommended] ").strip()
    if not raw:
        return recommended
    picked = []
    index = {str(i): m["id"] for i, m in enumerate(catalog, 1)}
    index.update(by_id(catalog))
    for tok in raw.replace(",", " ").split():
        if tok not in index:
            raise SystemExit(f"Unknown choice: {tok}")
        picked.append(index[tok])
    # unique preserve order
    seen = set()
    out = []
    for x in picked:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def uninstall(scope: str, project: Path | None, catalog: list[dict]) -> None:
    files_root, settings_path = dest_for(scope, project)
    if settings_path.is_file():
        backup(settings_path)
        settings = strip_our_hooks(read_json(settings_path, {}), files_root)
        for mod in catalog:
            if mod["kind"] == "settings":
                apply_settings_module(settings, mod, enable=False)
            if mod["kind"] == "statusline":
                apply_statusline(settings, files_root, enable=False)
        write_json(settings_path, settings)
    for mid in ("rules", "skill"):
        install_files_module(by_id(catalog)[mid], scope, project, enable=False)
    if scope == "user":
        note = uninstall_mod()
        if note:
            print(note)
    if files_root.is_dir():
        shutil.rmtree(files_root)
    print(f"Removed token-saver files from {files_root}")
    print(f"Our hooks stripped from {settings_path}")
    print("Your other Claude Code settings were left in place.")


def main() -> int:
    catalog = load_catalog()
    parser = argparse.ArgumentParser(
        description="Install and toggle Claude Code token-saver modules per engineer."
    )
    parser.add_argument("--scope", choices=("user", "project"), default="user",
                        help="user = ~/.claude (all repos). project = this repo only, settings.local.json")
    parser.add_argument("--project", type=Path, default=None)
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("status", help="Show what is enabled")
    p_en = sub.add_parser("enable", help="Enable modules (comma-separated ids)")
    p_en.add_argument("modules")
    p_dis = sub.add_parser("disable", help="Disable modules")
    p_dis.add_argument("modules")
    sub.add_parser("install", help="Copy files, enable nothing")
    sub.add_parser("recommended", help="Enable the recommended set")
    sub.add_parser("uninstall", help="Remove our hooks, rules, skill, and files")
    sub.add_parser("interactive", help="Checklist picker")
    sub.add_parser("dash", help="Terminal dashboard from local Claude Code transcripts")
    sub.add_parser("bench", help="Hook bench or live Claude A/B")
    sub.add_parser("skills", help="Park / unpark / link skills (status, pick, park, unpark, link, unlink)")
    p_setup = sub.add_parser("setup", help="One shot: files, mod, recommended modules, preflight. No questions.")
    p_setup.add_argument("--no-mod", action="store_true", help="skip the in-process mod, Python hooks only")
    p_setup.add_argument("--dry-run", action="store_true", help="show what would change")
    p_setup.add_argument("--plain", action="store_true", help="no animation (also TOKEN_SAVER_PLAIN=1)")
    parser.add_argument("legacy", nargs="?", help=argparse.SUPPRESS)

    args, rest = parser.parse_known_args()
    cmd = args.cmd or "interactive"
    files_root, settings_path = dest_for(args.scope, args.project)

    if cmd in {"dash", "bench"}:
        tui = PACK_ROOT / "scripts" / "tui.py"
        return subprocess.call([sys.executable, str(tui), cmd, *rest])
    if cmd == "skills":
        tool = PACK_ROOT / "plugins" / "token-saver" / "scripts" / "skills.py"
        return subprocess.call([sys.executable, str(tool), *rest])

    if cmd == "setup":
        return setup(args.scope, args.project, catalog, with_mod=not args.no_mod, dry_run=args.dry_run, plain=args.plain)
    if cmd == "status":
        print_status(args.scope, args.project, catalog)
        return 0
    if cmd == "uninstall":
        uninstall(args.scope, args.project, catalog)
        return 0
    if cmd == "install":
        copy_pack_files(files_root)
        write_json(state_path(files_root), {"scope": args.scope, "enabled": [], "updated": datetime.now().isoformat(timespec="seconds")})
        print(f"token-saver  files copied to {tilde(files_root)}, nothing enabled")
        print("  next       ./install.sh   (or ./install.sh --pick)")
        return 0
    if cmd == "interactive":
        enabled = interactive(args.scope, args.project, catalog)
    elif cmd == "recommended":
        # The recommended set is what setup installs; route there so the mod comes along.
        return setup(args.scope, args.project, catalog, with_mod=True, dry_run=False)
    elif cmd == "enable":
        extra = parse_ids(args.modules, catalog)
        enabled = current_enabled(files_root)
        for mid in extra:
            if mid not in enabled:
                enabled.append(mid)
    elif cmd == "disable":
        drop = set(parse_ids(args.modules, catalog))
        enabled = [m for m in current_enabled(files_root) if m not in drop]
    else:
        parser.print_help()
        return 2

    settings_now = read_json(settings_path, {})
    mod_on = mod_rewrite_enabled()
    enabled, notes = preflight(enabled, settings_now, files_root, mod_on)
    sync(args.scope, args.project, enabled, catalog)
    plugin, market = mod_ids()
    summary(settings_path, files_root, enabled, notes, f"{plugin}@{market}" if mod_on else None,
            foreign_hooks(settings_now, files_root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
