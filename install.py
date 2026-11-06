#!/usr/bin/env python3
"""Installs the OMP sidebar into a Herdr app folder (default ~/.config/herdr-app).

usage: install.py [--home DIR] [--layout NAME] [--no-toolbar]
Existing files are backed up as <name>.bak before they are replaced.
"""
import argparse
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
BLOCK = {"id": "omp-todos", "type": "block", "size": {"px": 260}, "min": 180, "max": 480, "content": {"mod": "omp-todos"}}


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, data):
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def copy_mod(name, home):
    dest = os.path.join(home, "mods", name)
    if os.path.exists(dest):
        shutil.copytree(dest, dest + ".bak", dirs_exist_ok=True)
    shutil.copytree(os.path.join(HERE, "mods", name), dest, dirs_exist_ok=True)
    print(f"mod      {name}")


def find(node, ident):
    if isinstance(node, dict):
        if node.get("id") == ident:
            return node
        for child in node.get("children", []):
            hit = find(child, ident)
            if hit:
                return hit
    return None


def add_block(layout):
    """Puts the panel inside `work-body`, before `panel` (or at its end)."""
    parent = find(layout, "work-body")
    if parent is None or find(layout, "omp-todos"):
        return parent is not None
    children = parent["children"]
    index = next((i for i, c in enumerate(children) if c.get("id") == "panel"), len(children))
    children.insert(index, BLOCK)
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--home", default=os.path.expanduser("~/.config/herdr-app"))
    p.add_argument("--layout", default="my")
    p.add_argument("--no-toolbar", action="store_true", help="do not replace mods/tabs-address (the OMP toolbar button)")
    a = p.parse_args()
    home = a.home

    for name in ("omp-todos", "omp-models", "omp-detail", "omp-changes") + (() if a.no_toolbar else ("tabs-address",)):
        copy_mod(name, home)

    os.makedirs(os.path.join(home, "custom-icons"), exist_ok=True)
    shutil.copy2(os.path.join(HERE, "custom-icons", "omp.svg"), os.path.join(home, "custom-icons", "omp.svg"))

    path = os.path.join(home, "programs.json")
    programs = load(path, {"programs": {}})
    programs.setdefault("programs", {})["omp"] = {"name": "OMP", "icon": "custom-icons/omp.svg", "tint": False, "tile": "#29243e", "run": ["omp"]}
    save(path, programs)
    print("programs omp")

    path = os.path.join(home, "keys.json")
    keys = load(path, {})
    keys.setdefault("ctrl-shift-u", "layout.toggle:omp-todos")
    save(path, keys)
    print("keys     ctrl-shift-u")

    path = os.path.join(home, "layouts", f"{a.layout}.json")
    layout = load(path, None)
    if layout is not None and add_block(layout):
        save(path, layout)
        print(f"layout   {a.layout}")
    else:
        print(f"layout   NOT changed: add this block inside your layout's `work-body` children:\n{json.dumps(BLOCK, indent=2)}")
    print("done; Herdr reloads mods on its own. Run `herdr-app check` on each mod if the panel is missing.")


main()
