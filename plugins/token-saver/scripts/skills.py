#!/usr/bin/env python3
"""Park, unpark and link Claude Code skills. Stdlib only.

Every skill under ~/.claude/skills costs tokens on every turn: its name and
description sit in the skill listing inside the system prompt. Parking moves a
skill to ~/.claude/skills-parked, where it costs nothing until you bring it
back everywhere (unpark) or for one project only (link).

Nothing here deletes a skill. Moves are renames; links are symlinks.
Changes take effect in the next session (/clear or restart).
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

PATTERN = r'"skill":\s*"[^"]+"'


def config_dir() -> Path:
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(cfg).expanduser() if cfg else Path.home() / ".claude"


SKILLS = config_dir() / "skills"
PARKED = config_dir() / "skills-parked"
MANIFEST = PARKED / ".parked.json"


# ---------- reading skills ----------

def approx_tokens(chars: int) -> int:
    return max(1, round(chars / 4)) if chars else 0


def description_of(skill_md: Path) -> str:
    """The frontmatter description, folded continuation lines included."""
    try:
        lines = skill_md.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    if not lines or lines[0].strip() != "---":
        return ""
    out: list[str] = []
    grabbing = False
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if grabbing:
            if line.startswith((" ", "\t")):
                out.append(line.strip())
                continue
            break
        if line.startswith("description:"):
            grabbing = True
            first = line[len("description:"):].strip()
            if first and first not in (">", "|", ">-", "|-"):
                out.append(first)
    return " ".join(out).strip()


def entries(root: Path) -> list[dict]:
    rows = []
    if not root.is_dir():
        return rows
    for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if child.name.startswith("."):
            continue
        md = child / "SKILL.md"
        if not md.is_file():
            continue
        desc = description_of(md)
        try:
            body = md.stat().st_size
        except OSError:
            body = 0
        rows.append(
            {
                "name": child.name,
                "path": str(child),
                "is_link": child.is_symlink(),
                "target": os.readlink(child) if child.is_symlink() else None,
                "desc_chars": len(desc),
                "per_turn": approx_tokens(len(child.name) + len(desc) + 4),
                "on_invoke": approx_tokens(body),
            }
        )
    return rows


def groups(names: list[str]) -> dict[str, str]:
    """name -> group prefix, when two or more share the part before the first dash."""
    by_prefix: dict[str, list[str]] = {}
    for n in names:
        by_prefix.setdefault(n.split("-")[0], []).append(n)
    return {n: p for p, ns in by_prefix.items() if len(ns) >= 2 for n in ns}


# ---------- usage from transcripts ----------

def transcript_roots() -> list[Path]:
    roots = [config_dir() / "projects", Path.home() / ".claude" / "projects"]
    seen, out = set(), []
    for r in roots:
        if r.is_dir() and r not in seen:
            seen.add(r)
            out.append(r)
    return out


SCAN_NOTE = ""
CACHE = config_dir() / "token-saver" / "skills-usage.json"
CACHE_TTL = 3600


def claude_bin() -> str | None:
    """Claude Code ships ripgrep inside its own binary (argv[0] = rg). Fast on 6 GB; BSD grep is not."""
    for cand in (os.environ.get("CLAUDE_CODE_EXECPATH"), shutil.which("claude"), str(Path.home() / ".local" / "bin" / "claude")):
        if cand and os.access(cand, os.X_OK):
            return cand
    return None


def usage_scan(timeout: int = 30, rescan: bool = False) -> dict[str, dict]:
    """skill name -> {count, last}: Skill tool invocations found in local transcripts.

    Cached for an hour under ~/.claude/token-saver/. Needs the claude binary; with
    only BSD grep the scan would take half a minute, so it is skipped and said so.
    """
    global SCAN_NOTE
    if not rescan:
        try:
            cached = json.loads(CACHE.read_text())
            if time.time() - float(cached.get("at", 0)) < CACHE_TTL:
                SCAN_NOTE = f"usage from cache ({int((time.time() - cached['at']) // 60)}m old; --rescan to refresh)"
                return cached.get("usage", {})
        except (OSError, ValueError, KeyError, TypeError):
            pass
    roots = [str(r) for r in transcript_roots()]
    if not roots:
        SCAN_NOTE = "no transcripts found"
        return {}
    exe = claude_bin()
    if not exe:
        SCAN_NOTE = "usage scan skipped: needs the claude binary on PATH (BSD grep takes ~30s on a large transcript dir)"
        return {}
    cmd = ["rg", "-oH", "--no-heading", "-g", "*.jsonl", PATTERN, *roots]
    try:
        res = subprocess.run(cmd, executable=exe, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        SCAN_NOTE = "usage scan skipped: rg via claude failed or timed out"
        return {}
    if res.returncode not in (0, 1):
        SCAN_NOTE = f"usage scan skipped: rg exit {res.returncode}"
        return {}
    usage = _fold_usage(res.stdout)
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps({"at": time.time(), "usage": usage}))
    except OSError:
        pass
    SCAN_NOTE = f"usage from {len(roots)} transcript dir(s), scanned just now"
    return usage


def _fold_usage(text: str) -> dict[str, dict]:
    mtimes: dict[str, float] = {}
    out: dict[str, dict] = {}
    for line in text.splitlines():
        file, sep, match = line.rpartition(':"skill"')
        if not sep:
            continue
        name = match.split('"')[-2] if match.count('"') >= 2 else ""
        if not name:
            continue
        if file not in mtimes:
            try:
                mtimes[file] = os.stat(file).st_mtime
            except OSError:
                mtimes[file] = 0.0
        row = out.setdefault(name, {"count": 0, "last": 0.0})
        row["count"] += 1
        row["last"] = max(row["last"], mtimes[file])
    return out


def days_ago(ts: float) -> int | None:
    if not ts:
        return None
    return int((time.time() - ts) // 86400)


# ---------- manifest ----------

def load_manifest() -> dict:
    try:
        return json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        return {}


def save_manifest(data: dict) -> None:
    PARKED.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


# ---------- name resolution ----------

def split_names(raw: list[str]) -> list[str]:
    out = []
    for item in raw:
        out.extend(p for p in item.split(",") if p.strip())
    return [p.strip() for p in out]


def resolve(patterns: list[str], pool: list[str], unused: list[str]) -> tuple[list[str], list[str]]:
    grp = groups(pool)
    picked: list[str] = []
    missing: list[str] = []
    for pat in split_names(patterns):
        if pat == "unused":
            hits = unused
        elif pat.startswith("@"):
            hits = [n for n in pool if grp.get(n) == pat[1:]]
        elif any(c in pat for c in "*?["):
            hits = fnmatch.filter(pool, pat)
        else:
            hits = [pat] if pat in pool else []
        if not hits:
            missing.append(pat)
        for h in hits:
            if h not in picked:
                picked.append(h)
    return picked, missing


# ---------- actions ----------

def _move(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(src, dst)
    except OSError:
        shutil.move(str(src), str(dst))


def _fix_link(moved: Path, target_abs: str | None) -> None:
    """A relative symlink may stop resolving after a move. Point it at the absolute target."""
    if moved.is_symlink() and not moved.exists() and target_abs:
        moved.unlink()
        os.symlink(target_abs, moved)


def park(names: list[str]) -> list[str]:
    manifest = load_manifest()
    done = []
    for name in names:
        src = SKILLS / name
        dst = PARKED / name
        if not os.path.lexists(src):
            print(f"  skip {name}: not in {SKILLS}")
            continue
        if os.path.lexists(dst):
            print(f"  skip {name}: already parked")
            continue
        target_abs = str((src.parent / os.readlink(src)).resolve()) if src.is_symlink() else None
        _move(src, dst)
        _fix_link(dst, target_abs)
        manifest[name] = {
            "from": str(src),
            "is_link": target_abs is not None,
            "target": target_abs,
            "parked_at": datetime.now().isoformat(timespec="seconds"),
        }
        done.append(name)
    save_manifest(manifest)
    return done


def unpark(names: list[str]) -> list[str]:
    manifest = load_manifest()
    done = []
    for name in names:
        src = PARKED / name
        if not os.path.lexists(src):
            print(f"  skip {name}: not parked")
            continue
        info = manifest.get(name, {})
        dst = Path(info.get("from") or SKILLS / name)
        if os.path.lexists(dst):
            print(f"  skip {name}: {dst} already exists")
            continue
        _move(src, dst)
        _fix_link(dst, info.get("target"))
        manifest.pop(name, None)
        done.append(name)
    save_manifest(manifest)
    return done


def link(names: list[str], project: Path) -> list[str]:
    skills_dir = project / ".claude" / "skills"
    done = []
    for name in names:
        src = PARKED / name
        if not os.path.lexists(src):
            print(f"  skip {name}: not parked (only parked skills are linked)")
            continue
        dst = skills_dir / name
        if os.path.lexists(dst):
            print(f"  skip {name}: {dst} already exists")
            continue
        skills_dir.mkdir(parents=True, exist_ok=True)
        os.symlink(str(src.resolve() if src.is_symlink() else src), dst)
        done.append(name)
    return done


def unlink(names: list[str], project: Path) -> list[str]:
    skills_dir = project / ".claude" / "skills"
    done = []
    for name in names:
        dst = skills_dir / name
        if not dst.is_symlink():
            print(f"  skip {name}: {dst} is not a link (nothing deleted)")
            continue
        dst.unlink()
        done.append(name)
    return done


def project_links(project: Path) -> list[str]:
    skills_dir = project / ".claude" / "skills"
    if not skills_dir.is_dir():
        return []
    out = []
    for child in sorted(skills_dir.iterdir()):
        if child.is_symlink():
            try:
                target = (child.parent / os.readlink(child)).resolve()
            except OSError:
                continue
            if str(target).startswith(str(PARKED.resolve())) or str(os.readlink(child)).startswith(str(PARKED)):
                out.append(child.name)
    return out



# ---------- suggest: match parked skills to this repo ----------

STOP = set("""the and for with when use this that from into your skill skills user asks uses using used
build builds building create creates creating make makes making work working works any all are can has have
not only also like want wants need needs then them they their there these those will would should about
after before where which while whose over under more most such than very just into onto per via each
every some other another first last new old one two three four five six seven eight nine ten""".split())

ALIASES = {
    "next": ["react"], "nextjs": ["react"], "@react-three/fiber": ["three", "3d"], "three": ["three", "3d"],
    "gsap": ["gsap", "animation", "motion"], "framer-motion": ["animation", "motion"],
    "tailwindcss": ["tailwind", "css"], "vue": ["vue"], "nuxt": ["vue"], "svelte": ["svelte"], "@sveltejs/kit": ["svelte"],
    "vite": ["frontend"], "electron": ["electron", "desktop"], "ink": ["ink", "terminal", "cli"],
    "react": ["react", "frontend"], "react-dom": ["react", "frontend"], "express": ["node", "server"],
    "d3": ["chart", "visualization"], "recharts": ["chart", "visualization"], "plotly": ["chart", "visualization"],
}


def _words(text: str) -> set[str]:
    out = set()
    for w in "".join(c.lower() if c.isalnum() else " " for c in text).split():
        if len(w) >= 3 and w not in STOP and not w.isdigit():
            out.add(w)
    return out


def _dep_names(pkg: dict) -> list[str]:
    names = []
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        d = pkg.get(key) or {}
        if isinstance(d, dict):
            names.extend(d.keys())
    return names


STRONG = 3
WEAK = 1


def repo_signals(project: Path) -> dict[str, tuple[str, int]]:
    """signal word -> (where it came from, weight). Direct dependency names and file
    types weigh STRONG; aliases and broad language words weigh WEAK so they can hint
    but never carry a match on their own. Cheap: a few manifests, two directory levels."""
    sig: dict[str, tuple[str, int]] = {}

    def add(word: str, src: str, weight: int = STRONG) -> None:
        w = word.lower().strip()
        if not w:
            return
        if w not in sig or sig[w][1] < weight:
            sig[w] = (src, weight)

    pkg_path = project / "package.json"
    if pkg_path.is_file():
        try:
            pkg = json.loads(pkg_path.read_text(encoding="utf-8", errors="replace"))
        except ValueError:
            pkg = {}
        add("javascript", "package.json", WEAK)
        for dep in _dep_names(pkg):
            add(dep, "package.json")
            bare = dep.split("/")[-1]
            add(bare, "package.json")
            for alias in ALIASES.get(dep, []) + ALIASES.get(bare, []):
                add(alias, "package.json", STRONG if alias == bare else WEAK)
        if (project / "tsconfig.json").is_file():
            add("typescript", "tsconfig.json", WEAK)
    for fname, words in (
        ("Package.swift", ["swift", "spm"]),
        ("pyproject.toml", ["python"]),
        ("requirements.txt", ["python"]),
        ("Cargo.toml", ["rust", "cargo"]),
        ("go.mod", ["go", "golang"]),
        ("Gemfile", ["ruby", "rails"]),
        ("Podfile", ["ios", "cocoapods"]),
        ("tailwind.config.js", ["tailwind", "css"]),
        ("tailwind.config.ts", ["tailwind", "css"]),
    ):
        if (project / fname).is_file():
            for w in words:
                add(w, fname)
    # two levels of names: xcodeproj, swift, html, figma exports, etc.
    seen_swift = seen_html = False
    try:
        for depth, folder in ((0, project), *((1, d) for d in project.iterdir() if d.is_dir() and not d.name.startswith(".") and d.name != "node_modules")):
            for child in folder.iterdir():
                n = child.name
                if n.endswith(".xcodeproj") or n.endswith(".xcworkspace"):
                    for w in ("ios", "xcode", "swift", "swiftui"):
                        add(w, n)
                elif n.endswith(".swift") and not seen_swift:
                    seen_swift = True
                    for w in ("swift", "swiftui"):
                        add(w, n)
                elif n.endswith(".html") and not seen_html and child.is_file() and child.stat().st_size < 2_000_000:
                    seen_html = True
                    add("html", n, WEAK)
                    try:
                        head = child.read_text(encoding="utf-8", errors="replace")[:200_000].lower()
                    except OSError:
                        head = ""
                    for lib in ("gsap", "three", "tailwind", "alpine", "htmx", "lottie"):
                        if lib in head:
                            add(lib, n)
                            for alias in ALIASES.get(lib, []):
                                add(alias, n, WEAK)
    except OSError:
        pass
    for fname in ("pyproject.toml", "requirements.txt"):
        fp = project / fname
        if fp.is_file():
            try:
                for line in fp.read_text(encoding="utf-8", errors="replace").splitlines()[:300]:
                    line = line.strip().split("#")[0]
                    if fname == "requirements.txt" and line and line[0].isalpha():
                        add("".join(c for c in line if c.isalnum() or c in "-_").split("[")[0], fname)
            except OSError:
                pass
    return sig


def score_skill(entry: dict, signals: dict[str, tuple[str, int]]) -> tuple[int, list[str]]:
    """STRONG signal in the name: 3. STRONG signal in the description: 1. WEAK signal in
    the name: 1. WEAK signals never match descriptions. A skill is a real match at 3+."""
    name_parts = set(entry["name"].lower().split("-"))
    desc_words = _words(description_of(Path(entry["path"]) / "SKILL.md"))
    score = 0
    reasons: list[tuple[int, str]] = []
    for sig, (src, weight) in signals.items():
        in_name = sig in name_parts or any(sig in part and len(sig) >= 4 for part in name_parts)
        if in_name:
            pts = weight
        elif weight == STRONG and sig in desc_words:
            pts = 1
        else:
            continue
        score += pts
        reasons.append((pts, f"{sig} ({src})"))
    reasons.sort(key=lambda r: -r[0])
    return score, [r for _, r in reasons]


def compact_names(hits: list[str], pool: list[str]) -> list[str]:
    """Fold a prefix group into `prefix-*` when three or more hits share it and the glob
    would select nothing outside the hits. Keeps /park link lines short and complete."""
    by_prefix: dict[str, list[str]] = {}
    for n in hits:
        by_prefix.setdefault(n.split("-")[0], []).append(n)
    out: list[str] = []
    for n in hits:
        prefix = n.split("-")[0]
        members = by_prefix[prefix]
        in_pool = [m for m in pool if m == prefix or m.startswith(prefix + "-")]
        if len(members) >= 3 and set(in_pool) <= set(members):
            glob = f"{prefix}-*"
            if glob not in out:
                out.append(glob)
        else:
            out.append(n)
    return out


def suggest(project: Path, topic: str, as_json: bool, brief: bool) -> int:
    signals = repo_signals(project)
    for w in _words(topic):
        signals[w] = ("asked", STRONG)
    parked = entries(PARKED)
    active = entries(SKILLS)
    linked = set(project_links(project))

    def ranked(rows: list[dict]) -> list[tuple[int, dict, list[str]]]:
        out = []
        for e in rows:
            sc, why = score_skill(e, signals)
            if sc > 0:
                out.append((sc, e, why))
        return sorted(out, key=lambda t: (-t[0], t[1]["name"]))

    parked_hits = [t for t in ranked(parked) if t[1]["name"] not in linked][:10]
    active_hits = [t for t in ranked(active) if t[0] >= STRONG][:6] if topic else []
    strong = [t for t in parked_hits if t[0] >= STRONG]
    maybe = [t for t in parked_hits if t[0] < STRONG]

    if as_json:
        print(json.dumps({
            "signals": {k: {"source": v[0], "weight": v[1]} for k, v in signals.items()},
            "parked_matches": [{"name": e["name"], "score": sc, "why": why} for sc, e, why in strong],
            "maybe": [{"name": e["name"], "score": sc, "why": why} for sc, e, why in maybe],
            "active_matches": [{"name": e["name"], "score": sc, "why": why} for sc, e, why in active_hits],
            "link_command": f"skills.py link {' '.join(e['name'] for _, e, _ in strong)}" if strong else None,
        }, indent=1))
        return 0

    if brief:
        if not strong:
            return 0
        names = compact_names([e["name"] for _, e, _ in strong], [e["name"] for e in parked])
        srcs = sorted({r.split("(")[1].rstrip(")") for _, _, why in strong[:6] for r in why[:2]})
        print(f"Parked skills match this repo: {', '.join(names[:6])}{' …' if len(names) > 6 else ''} "
              f"(from {', '.join(srcs[:3])}). Enable here: /park link {' '.join(names)}   (loads after /clear)")
        return 0

    if not signals:
        print(f"No repo signals in {project} (no package.json, Package.swift, pyproject, Cargo.toml, go.mod, html…).")
    else:
        shown = sorted(signals.items(), key=lambda kv: (-kv[1][1], kv[1][0], kv[0]))[:14]
        print("Repo signals: " + ", ".join(k if w == STRONG else f"{k}?" for k, (_, w) in shown)
              + (" …" if len(signals) > 14 else "") + "   (? = weak hint)")
    if topic:
        print(f"Asked for: {topic}")
    if active_hits:
        print("\nAlready active (use it with the Skill tool):")
        for sc, e, why in active_hits:
            print(f"  {e['name']:<34} {', '.join(why[:3])}")
    if parked_hits:
        if strong:
            print("\nParked skills that fit this repo:")
            for sc, e, why in strong:
                print(f"  {e['name']:<34} {e['per_turn']:>4} tok/turn   {', '.join(why[:3])}")
        if maybe:
            print("\nMaybe (weak hints only, not in the command below):")
            for sc, e, why in maybe:
                print(f"  {e['name']:<34} {e['per_turn']:>4} tok/turn   {', '.join(why[:3])}")
        if strong:
            names = " ".join(compact_names([e["name"] for _, e, _ in strong], [e["name"] for e in parked]))
            print(f"\nEnable for this repo only:  skills.py link {names}")
            print(f"Enable everywhere:          skills.py unpark {names}")
            print("Loads in the next session (/clear). In a mod session: /park link <names>")
        else:
            print("\nOnly weak hints. Enable one by name if you want it: skills.py link <name>")
    elif topic and not active_hits:
        print("\nNo active or parked skill matches. Nothing to enable.")
    elif not parked_hits:
        print("\nNo parked skill matches this repo.")
    return 0


# ---------- rendering ----------

def fmt_last(u: dict | None) -> str:
    if not u:
        return "never"
    d = days_ago(u["last"])
    if d is None:
        return "never"
    if d == 0:
        return f"today ×{u['count']}"
    return f"{d}d ago ×{u['count']}"


def unused_names(active: list[dict], usage: dict, unused_days: int) -> list[str]:
    out = []
    for e in active:
        u = usage.get(e["name"])
        d = days_ago(u["last"]) if u else None
        if d is None or d >= unused_days:
            out.append(e["name"])
    return out


def table(active: list[dict], usage: dict, unused: set[str], numbered: bool) -> tuple[list[dict], list[str]]:
    """Rows in display order (unused first, then costliest) and their printed lines."""
    grp = groups([e["name"] for e in active])
    rows = sorted(active, key=lambda e: (e["name"] not in unused, -e["per_turn"], e["name"]))
    lines = []
    width = max((len(e["name"]) for e in rows), default=10)
    for i, e in enumerate(rows, 1):
        mark = "·" if e["name"] in unused else " "
        num = f"{i:>3} " if numbered else ""
        flags = []
        if e["is_link"]:
            flags.append("sym")
        if grp.get(e["name"]):
            flags.append("@" + grp[e["name"]])
        lines.append(
            f"{num}{mark} {e['name']:<{width}}  {e['per_turn']:>4} tok/turn  {e['on_invoke']:>5} on use  "
            f"{fmt_last(usage.get(e['name'])):<16} {' '.join(flags)}".rstrip()
        )
    return rows, lines


def next_steps(parked_now: list[str]) -> str:
    sample = parked_now[0] if parked_now else "<name>"
    return "\n".join(
        [
            "Takes effect in your next session: /clear or restart Claude Code.",
            "Bring one back:",
            f"  everywhere      skills.py unpark {sample}",
            f"  this repo only  skills.py link {sample}      (symlink into .claude/skills; gitignore it if teammates lack the skill)",
            "  undo a link     skills.py unlink <name>       (removes the link only)",
            "Globs and groups work everywhere: gsap-*  @higgsfield  unused",
        ]
    )


def status(project: Path, unused_days: int, with_usage: bool, as_json: bool, rescan: bool = False) -> int:
    active = entries(SKILLS)
    parked = entries(PARKED)
    usage = usage_scan(rescan=rescan) if with_usage else {}
    unused = set(unused_names(active, usage, unused_days)) if with_usage else set()
    links = project_links(project)
    per_turn = sum(e["per_turn"] for e in active)
    saved = sum(e["per_turn"] for e in parked)
    if as_json:
        print(json.dumps({"active": active, "parked": parked, "usage": usage, "unused": sorted(unused),
                          "project_links": links, "per_turn_tokens": per_turn, "parked_tokens": saved,
                          "scan_note": SCAN_NOTE}, indent=1))
        return 0
    print(f"Active skills: {len(active)}  ≈{per_turn} tok on every turn (name + description in the listing)")
    for line in table(active, usage, unused, numbered=False)[1]:
        print(line)
    if with_usage:
        print(f"  · = no Skill call in local transcripts for {unused_days}+ days ({len(unused)} skills, "
              f"≈{sum(e['per_turn'] for e in active if e['name'] in unused)} tok/turn)   sym = symlinked skill")
        if SCAN_NOTE:
            print(f"  {SCAN_NOTE}")
    grp = groups([e["name"] for e in parked])
    if parked:
        by: dict[str, list[str]] = {}
        for e in parked:
            by.setdefault(grp.get(e["name"], "other"), []).append(e["name"])
        print(f"\nParked: {len(parked)}  ≈{saved} tok/turn kept out of the prompt")
        for g, ns in sorted(by.items()):
            shown = [f"{n} ({fmt_last(usage[n])})" if usage.get(n) else n for n in ns]
            print(f"  {g:<12} {', '.join(shown)}")
        used = [n for n in (e["name"] for e in parked) if usage.get(n)]
        if used:
            print(f"  used while parked: {', '.join(used)}  →  skills.py link <name> for one repo, unpark for all")
    if links:
        print(f"\nLinked into {project}/.claude/skills: {', '.join(links)}")
    print("\nskills.py pick            interactive picker")
    print("skills.py park <names>    unpark <names>   link <names>   unlink <names>")
    return 0


def pick(project: Path, unused_days: int, with_usage: bool, rescan: bool = False) -> int:
    active = entries(SKILLS)
    if not active:
        print(f"No skills in {SKILLS}.")
        return 0
    usage = usage_scan(rescan=rescan) if with_usage else {}
    unused = unused_names(active, usage, unused_days) if with_usage else []
    print(f"Active skills: {len(active)}  ≈{sum(e['per_turn'] for e in active)} tok on every turn\n")
    rows, lines = table(active, usage, set(unused), numbered=True)
    for line in lines:
        print(line)
    ordered = [e["name"] for e in rows]
    if with_usage:
        print(f"\n  · = unused {unused_days}+ days  ({len(unused)} skills)")
    print("\nPark which? numbers, names, globs (gsap-*), groups (@gsap), 'unused', or Enter to cancel.")
    try:
        raw = input("> ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return 1
    if not raw:
        print("Nothing changed.")
        return 0
    tokens = raw.replace(",", " ").split()
    names: list[str] = []
    patterns: list[str] = []
    for t in tokens:
        if t.isdigit() and 1 <= int(t) <= len(ordered):
            names.append(ordered[int(t) - 1])
        else:
            patterns.append(t)
    picked, missing = resolve(patterns, [e["name"] for e in active], unused)
    for p in picked:
        if p not in names:
            names.append(p)
    if missing:
        print(f"Unknown: {', '.join(missing)}")
    if not names:
        print("Nothing changed.")
        return 1
    saving = sum(e["per_turn"] for e in active if e["name"] in names)
    print(f"\nPark {len(names)} skill(s), ≈{saving} tok/turn: {', '.join(names)}")
    try:
        ok = input("Proceed? [y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return 1
    if ok not in ("y", "yes"):
        print("Nothing changed.")
        return 0
    done = park(names)
    print(f"\nParked {len(done)}: {', '.join(done)}  →  {PARKED}")
    print(next_steps(done))
    return 0


def main() -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--project", type=Path, default=Path.cwd(), help="repo for link/unlink (default: cwd)")
    common.add_argument("--unused-days", type=int, default=30, help="mark skills with no Skill call in N days (default 30)")
    common.add_argument("--no-usage", action="store_true", help="skip the transcript scan")
    common.add_argument("--rescan", action="store_true", help="ignore the hourly usage cache")
    common.add_argument("--json", action="store_true", help="machine-readable status")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, parents=[common])
    # Flags are accepted before or after the subcommand.
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("status", help="what is active, parked and linked (default)", parents=[common])
    sub.add_parser("pick", help="interactive picker: choose what to park", parents=[common])
    for verb in ("park", "unpark", "link", "unlink"):
        p = sub.add_parser(verb, parents=[common])
        p.add_argument("names", nargs="+", help="names, globs (gsap-*), groups (@gsap), or 'unused'")
    sg = sub.add_parser("suggest", help="parked skills that fit this repo (or a topic)", parents=[common])
    sg.add_argument("--for", dest="topic", default="", help="a task or library to find a skill for")
    sg.add_argument("--brief", action="store_true", help="one line or nothing (for session-start hooks)")
    args = ap.parse_args()
    cmd = args.cmd or "status"
    project = args.project.resolve()

    if cmd == "status":
        return status(project, args.unused_days, not args.no_usage, args.json, args.rescan)
    if cmd == "pick":
        return pick(project, args.unused_days, not args.no_usage, args.rescan)
    if cmd == "suggest":
        return suggest(project, args.topic, args.json, args.brief)

    if cmd in ("park",):
        active = entries(SKILLS)
        usage = usage_scan(rescan=args.rescan) if not args.no_usage else {}
        pool = [e["name"] for e in active]
        unused = unused_names(active, usage, args.unused_days)
    elif cmd in ("unpark", "link"):
        pool = [e["name"] for e in entries(PARKED)]
        unused = []
    else:
        pool = project_links(project)
        unused = []
    names, missing = resolve(args.names, pool, unused)
    if missing:
        print(f"Unknown: {', '.join(missing)}  (pool: {', '.join(pool) or 'empty'})")
    if not names:
        return 1

    if cmd == "park":
        done = park(names)
        print(f"Parked {len(done)}: {', '.join(done)}  →  {PARKED}")
        if done:
            print(next_steps(done))
    elif cmd == "unpark":
        done = unpark(names)
        print(f"Unparked {len(done)}: {', '.join(done)}  →  {SKILLS}")
        if done:
            print("Takes effect in your next session: /clear or restart.")
    elif cmd == "link":
        done = link(names, project)
        print(f"Linked {len(done)} into {project / '.claude' / 'skills'}: {', '.join(done)}")
        if done:
            print("Loads only in this repo. Takes effect in your next session: /clear or restart.")
            print("Teammates without the parked skill will see a dangling link: add .claude/skills/<name> to .gitignore.")
    elif cmd == "unlink":
        done = unlink(names, project)
        print(f"Unlinked {len(done)}: {', '.join(done)}  (skills stay in {PARKED})")
    return 0 if names else 1


if __name__ == "__main__":
    raise SystemExit(main())
