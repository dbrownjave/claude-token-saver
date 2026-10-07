#!/usr/bin/env python3
"""Shim: the real script ships inside the mod so /skills can find it."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parents[1] / "plugins" / "token-saver" / "scripts" / "skills.py"), run_name="__main__")
