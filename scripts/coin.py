#!/usr/bin/env python3
"""An ASCII gold coin that spins, and a step list for the installer. Stdlib only.

    python3 scripts/coin.py --demo                # watch it
    python3 scripts/coin.py --demo --size 23      # bigger
    python3 scripts/coin.py --demo --emblem T     # raised letter on the face (default: none)
    python3 scripts/coin.py --demo --plain        # what CI and pipes see

Look: a thick disc rotating on its vertical axis. Brightness comes from a lit
face, a rim that flares when it turns edge-on, and a moving glint; it is carried
by glyph density and a dark-olive to pale-gold color ramp, with speckled holes.

Rules: no animation unless stdout is a TTY; no color under NO_COLOR or TERM=dumb;
the coin never hides a step's text; the final frame is the coin at rest, face up.
"""
from __future__ import annotations

import math
import os
import random
import shutil
import sys
import threading
import time
from contextlib import contextmanager

FPS = 20
TURN_SECONDS = 6.0
SPINNER = "◐◓◑◒"
THICKNESS = 0.44            # rim depth as a fraction of the radius (chunky, like the reference)
CELL_ASPECT = 2.0           # a terminal cell is about twice as tall as wide

# brightness ramp → ANSI 256 color
RAMP = [(0.14, None), (0.28, 58), (0.42, 94), (0.56, 136), (0.70, 178), (0.84, 220), (0.92, 222), (0.97, 230), (1.01, 231)]
POOL_DIM = ".·:,'`-"
POOL_MID = "+=;:il!~-*^/)(][}{<>?xzjtfkrvy"
POOL_HI = "#@0896&%$AEMWNHKXRSBDGQUZ"
POOL_HEX = "0123456789abcdef"
C_OK, C_SKIP, C_FAIL, C_DIM, C_TITLE = 114, 245, 203, 245, 220

# 5x7 bitmaps for the optional raised emblem
EMBLEMS = {
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "$": [".###.", "#.#..", "#.#..", ".###.", "..#.#", "..#.#", ".###."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
}


def want_color(stream) -> bool:
    if os.environ.get("NO_COLOR") or os.environ.get("TERM") == "dumb":
        return False
    return hasattr(stream, "isatty") and stream.isatty()


def paint(text: str, color: int | None, on: bool) -> str:
    return f"\033[38;5;{color}m{text}\033[0m" if on and color is not None else text


class Coin:
    """Renders frames of a spinning disc as rows of text."""

    def __init__(self, height: int = 19, emblem: str | None = None, seed: int = 7) -> None:
        self.h = max(9, height | 1)                      # odd, so there is a center row
        self.w = int(self.h * CELL_ASPECT) + 1
        self.emblem = EMBLEMS.get((emblem or "").upper())
        rnd = random.Random(seed)
        self.noise = [[rnd.random() for _ in range(self.w)] for _ in range(self.h)]
        self.glyph = [[rnd.random() for _ in range(self.w)] for _ in range(self.h)]
        self._shimmer = random.Random(seed + 1)

    def _emblem_hit(self, u: float, v: float) -> int:
        """1 on the raised letter, -1 in its drop shadow, 0 elsewhere. u,v in [-1,1] face coords."""
        if not self.emblem:
            return 0
        span = 0.62                                       # emblem spans ±span of the face
        for shadow in (False, True):
            uu, vv = (u - 0.07, v - 0.09) if shadow else (u, v)
            col = int((uu / span + 1) / 2 * 5)
            row = int((vv / span + 1) / 2 * 7)
            if 0 <= col < 5 and 0 <= row < 7 and self.emblem[row][col] == "#":
                return -1 if shadow else 1
        return 0

    def rows(self, theta: float, frame: int, color: bool) -> list[str]:
        """One frame. Geometry: a disc of radius 1 and thickness T whose normal is
        (sin θ, 0, cos θ). Its two faces project to ellipses of horizontal radius |cos θ|,
        centred at ±T/2·sin θ. The visible face is the one facing the viewer; the rim is
        the rest of the silhouette (the hull of both ellipses)."""
        c, s = math.cos(theta), math.sin(theta)
        rx = abs(c)
        shift = THICKNESS / 2 * s
        vis_sign = 1 if c >= 0 else -1                   # which face points at the viewer
        c_vis, c_hid = vis_sign * shift, -vis_sign * shift
        # light from the upper-left, a little in front of the coin
        lx, ly, lz = -0.30, -0.5, 0.92
        lam_face = max(0.55, vis_sign * (s * lx + c * lz)) if rx > 0.02 else 0.0   # stays amber as it turns
        # specular highlight slides across the face as it turns
        hx, hy = -0.42 + 0.35 * s, -0.38
        glint = 0.5 + 0.5 * math.sin(frame / 7.0)
        cy = (self.h - 1) / 2
        cx = (self.w - 1) / 2
        ry = cy
        out = []
        for j in range(self.h):
            v = (j - cy) / ry
            if v * v > 1.0:
                out.append(" " * self.w)
                continue
            bevel = 0.45 + 0.55 * math.sqrt(1 - v * v)      # the edge rounds off toward top and bottom
            c_vis, c_hid = vis_sign * shift * bevel, -vis_sign * shift * bevel
            half = rx * math.sqrt(1 - v * v)
            lo, hi = min(c_vis, c_hid) - half, max(c_vis, c_hid) + half
            line = []
            for i in range(self.w):
                u = (i - cx) / (ry * CELL_ASPECT)
                if u < lo or u > hi:
                    line.append(" ")
                    continue
                n = self.noise[j][i]
                du = (u - c_vis) / rx if rx > 0.02 else 9.0
                r2 = du * du + v * v
                if r2 <= 1.0:
                    kind = "face"
                    r = math.sqrt(r2)
                    grad = 1.0 - 0.42 * (du * 0.8 + v * 0.9)          # lit top-left, shadowed bottom-right
                    spec = max(0.0, 1 - math.hypot(du - hx, (v - hy) * 1.1) / 0.50) ** 1.6
                    if r > 0.90:
                        ring, lip = 0.0, 0.20                          # bright outer lip
                    elif r > 0.70:
                        ring, lip = -0.20, 0.0                         # recessed annulus
                    elif r > 0.64:
                        ring, lip = 0.16, 0.0                          # the inner disc's raised edge
                    else:
                        ring, lip = 0.0, 0.0
                    em = self._emblem_hit(du, v)
                    emb = 0.30 if em == 1 else (-0.24 if em == -1 else 0.0)
                    brightness = 0.26 + 0.52 * lam_face * grad + 0.70 * spec * (0.7 + 0.3 * glint) + ring + lip + emb
                    if n < 0.10:                                       # speckled holes
                        line.append(" ")
                        continue
                else:
                    kind = "rim"
                    side = -1.0 if u < (c_vis + c_hid) / 2 else 1.0
                    lit = side * lx > 0                                # the left rim faces the light
                    depth = abs(s)                                     # how much rim we are seeing
                    brightness = (0.62 + 0.36 * (0.75 + 0.25 * glint) if lit else 0.34) + 0.08 * depth - 0.16 * abs(v)
                b = max(0.0, min(1.0, brightness + (n - 0.5) * 0.20))
                g = self.glyph[j][i]
                if self._shimmer.random() < 0.035:
                    g = self._shimmer.random()
                    self.glyph[j][i] = g
                col = next(cc for lim, cc in RAMP if b < lim)
                if col is None:
                    line.append(" ")
                    continue
                line.append(paint(self._char(b, g, kind), col, color))
            out.append("".join(line))
        return out

    @staticmethod
    def _char(b: float, g: float, kind: str) -> str:
        if kind == "rim":
            if b > 0.8:
                return "=" if g < 0.5 else POOL_HI[int(g * 97) % len(POOL_HI)]
            return "=" if g < 0.6 else ("-" if g < 0.85 else "~")
        if 0.46 < g < 0.52:
            return "=" if b > 0.5 else "-"                   # horizontal streaks across the face
        if b < 0.35:
            return POOL_DIM[int(g * 1000) % len(POOL_DIM)]
        if b < 0.65:
            pool = POOL_MID if g < 0.7 else POOL_HEX
            return pool[int(g * 1000) % len(pool)]
        pool = POOL_HI if g < 0.75 else POOL_HEX
        return pool[int(g * 1000) % len(pool)]


class Step:
    __slots__ = ("label", "state", "detail")

    def __init__(self, label: str) -> None:
        self.label = label
        self.state = "pending"      # pending | running | done | skip | fail
        self.detail = ""


def fit_height(stream, requested: int | None) -> int:
    """Pick a coin height that leaves room for the steps and the summary."""
    if requested:
        return requested
    cols, rows = shutil.get_terminal_size((100, 40))
    by_rows = rows - 18                       # title, four steps, summary and a little air below the coin
    by_cols = int((cols - 6) / CELL_ASPECT)
    return max(11, min(21, by_rows, by_cols))


class Progress:
    """Coin on the left, steps on the right. Use as a context manager; call step()."""

    def __init__(self, title: str, labels: list[str], stream=None, animate: bool | None = None,
                 height: int | None = None, emblem: str | None = None) -> None:
        self.stream = stream or sys.stdout
        self.title = title
        self.steps = [Step(l) for l in labels]
        tty = hasattr(self.stream, "isatty") and self.stream.isatty()
        self.animate = tty if animate is None else (animate and tty)
        self.color = want_color(self.stream)
        self.coin = Coin(fit_height(self.stream, height), emblem)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._frame = 0
        self._drawn = 0

    # ---- drawing ----
    def _right(self) -> list[str]:
        right = [paint(self.title, C_TITLE, self.color), ""]
        for s in self.steps:
            if s.state == "running":
                mark = paint(SPINNER[self._frame % len(SPINNER)], C_TITLE, self.color)
            elif s.state == "done":
                mark = paint("✔", C_OK, self.color)
            elif s.state == "skip":
                mark = paint("–", C_SKIP, self.color)
            elif s.state == "fail":
                mark = paint("✘", C_FAIL, self.color)
            else:
                mark = paint("○", C_DIM, self.color)
            detail = paint(f"  {s.detail}", C_DIM, self.color) if s.detail else ""
            right.append(f"{mark} {s.label:<9}{detail}")
        return right

    def _lines(self, theta: float) -> list[str]:
        coin = [f"  {row}".rstrip() for row in self.coin.rows(theta, self._frame, self.color)]
        steps = [f"  {row}".rstrip() for row in self._right()]
        return coin + [""] + steps

    def _draw(self, theta: float) -> None:
        lines = self._lines(theta)
        out = f"\033[{self._drawn}A" if self._drawn else ""
        out += "".join("\033[2K" + l + "\n" for l in lines)
        self.stream.write(out)
        self.stream.flush()
        self._drawn = len(lines)

    def _spin(self) -> None:
        step = 2 * math.pi / (TURN_SECONDS * FPS)
        while not self._stop.is_set():
            with self._lock:
                self._frame += 1
                self._draw(self._frame * step)
            time.sleep(1 / FPS)

    # ---- lifecycle ----
    def __enter__(self) -> "Progress":
        if self.animate:
            self.stream.write("\033[?25l")
            self._draw(0.0)
            self._thread = threading.Thread(target=self._spin, daemon=True)
            self._thread.start()
        else:
            self.stream.write(f"{self.title}\n")
            self.stream.flush()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.animate:
            self._stop.set()
            if self._thread:
                self._thread.join(timeout=1)
            with self._lock:
                self._draw(0.0)                   # at rest, face up
            self.stream.write("\033[?25h")
            self.stream.flush()

    @contextmanager
    def step(self, label: str):
        s = next(x for x in self.steps if x.label == label)
        with self._lock:
            s.state = "running"
        try:
            yield s
        except Exception:
            with self._lock:
                s.state = "fail"
            raise
        else:
            with self._lock:
                if s.state == "running":
                    s.state = "done"
        finally:
            if not self.animate:
                mark = {"done": "✔", "skip": "–", "fail": "✘"}.get(s.state, "•")
                self.stream.write(f"  {mark} {label}" + (f"  {s.detail}" if s.detail else "") + "\n")
                self.stream.flush()


def demo(plain: bool, seconds: float, size: int | None, emblem: str | None) -> None:
    labels = ["files", "mod", "preflight", "modules"]
    details = ["~/.claude/token-saver", "token-saver@token-saver installed", "5 of your hooks kept",
               "rules · skill · session-audit · quiet-map"]
    with Progress("token-saver", labels, animate=not plain, height=size, emblem=emblem) as ui:
        for label, detail in zip(labels, details):
            with ui.step(label) as s:
                time.sleep(seconds / len(labels))
                s.detail = detail
    print("\n  next       open a new Claude Code session, or /clear")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--plain", action="store_true", help="no animation, no cursor control")
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--size", type=int, default=None, help="coin height in rows (odd, 9..25)")
    ap.add_argument("--emblem", default=None, help="raised letter on the face: T, $ or C")
    a = ap.parse_args()
    if a.demo:
        demo(a.plain, a.seconds, a.size, a.emblem)
    else:
        ap.print_help()
