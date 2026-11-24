#!/usr/bin/env python3
"""
Nugget engine -- build script.

Usage:
    python3 nugget-engine/build.py <instance-dir> <output-dir>

Reads an instance directory with the layout

    <instance>/site.md            site title, intro text (front matter + markdown)
    <instance>/nuggets/**/*.md    one nugget per file
    <instance>/groups/**/*.md     one group per file (optional; groups that are
                                  only mentioned in nuggets are created automatically)
    <instance>/assets/            images, code, ... (copied as-is)

and produces a static website in <output-dir> (the engine's web/ files,
the assets, and a single data file nuggets.json).

Only the Python standard library is used.
"""

import json
import os
import re
import shutil
import sys

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))

LINK_FIELDS = ["requires", "uses", "see-also", "next"]
LIST_FIELDS = ["groups"] + LINK_FIELDS + ["order"]


# ---------------------------------------------------------------------------
# front matter (a small, strict subset of YAML)

def parse_value(raw):
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        return [x.strip().strip("\"'") for x in inner.split(",") if x.strip()]
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def parse_file(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    meta, body = {}, text
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end < 0:
            raise ValueError(f"{path}: unterminated front matter")
        header = text[4:end]
        body = text[end + 4:].lstrip("\n")
        key = None
        for lineno, line in enumerate(header.split("\n"), 2):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            m = re.match(r"^([A-Za-z][\w-]*)\s*:\s*(.*)$", line)
            if m:
                key, val = m.group(1), m.group(2)
                meta[key] = parse_value(val) if val.strip() else []
            elif line.lstrip().startswith("- ") and key is not None:
                # block list:  key:\n  - a\n  - b
                if not isinstance(meta[key], list):
                    meta[key] = []
                meta[key].append(parse_value(line.lstrip()[2:]))
            else:
                raise ValueError(f"{path}:{lineno}: cannot parse front matter line: {line!r}")
    for k in LIST_FIELDS:
        if k in meta and isinstance(meta[k], str):
            meta[k] = [meta[k]]
    return meta, body


def walk_md(root):
    out = []
    if not os.path.isdir(root):
        return out
    for dirpath, _, files in os.walk(root):
        for fn in sorted(files):
            if fn.endswith(".md"):
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root)[:-3].replace(os.sep, "/")
                out.append((rel, full))
    return sorted(out)


# ---------------------------------------------------------------------------

def build(instance, outdir):
    errors, warnings = [], []

    site_meta, site_body = ({}, "")
    if os.path.exists(os.path.join(instance, "site.md")):
        site_meta, site_body = parse_file(os.path.join(instance, "site.md"))

    # nuggets
    nuggets = {}
    for rel, full in walk_md(os.path.join(instance, "nuggets")):
        meta, body = parse_file(full)
        nid = meta.get("id", os.path.basename(rel))
        if nid in nuggets:
            errors.append(f"duplicate nugget id '{nid}' ({full})")
        n = {
            "id": nid,
            "title": meta.get("title", nid),
            "kind": meta.get("kind", "note"),
            "groups": meta.get("groups", []),
            "body": body,
            "file": os.path.relpath(full, instance).replace(os.sep, "/"),
        }
        for k in LINK_FIELDS:
            n[k] = meta.get(k, [])
        for k, v in meta.items():
            if k not in n and k != "id":
                n[k] = v
        nuggets[nid] = n

    # inline references  [[id]]  or  [[id|text]]
    inline_ref = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")
    for n in nuggets.values():
        n["mentions"] = sorted(set(m.strip() for m in inline_ref.findall(n["body"])))

    # check references
    for n in nuggets.values():
        for k in LINK_FIELDS + ["mentions"]:
            for target in n[k]:
                if target not in nuggets:
                    errors.append(f"{n['file']}: {k} refers to unknown nugget '{target}'")

    # groups
    groups = {}
    for rel, full in walk_md(os.path.join(instance, "groups")):
        meta, body = parse_file(full)
        gid = meta.get("id", rel)
        groups[gid] = {
            "id": gid,
            "title": meta.get("title", gid),
            "order": meta.get("order", []),
            "rank": int(meta.get("rank", 1000)),
            "body": body,
        }
    for n in nuggets.values():
        for g in n["groups"]:
            if g not in groups:
                groups[g] = {"id": g, "title": g.split("/")[-1].replace("-", " "),
                             "order": [], "rank": 1000, "body": ""}
                warnings.append(f"group '{g}' has no file in groups/ (created automatically)")
    for g in groups.values():
        for nid in g["order"]:
            if nid not in nuggets:
                errors.append(f"group '{g['id']}' orders unknown nugget '{nid}'")
            elif g["id"] not in nuggets[nid]["groups"]:
                nuggets[nid]["groups"].append(g["id"])
        members = [nid for nid in g["order"] if nid in nuggets]
        rest = sorted((n["id"] for n in nuggets.values()
                       if g["id"] in n["groups"] and n["id"] not in members),
                      key=lambda i: nuggets[i]["title"].lower())
        g["members"] = members + rest
        del g["order"]

    if errors:
        for e in errors:
            print("ERROR:", e, file=sys.stderr)
        sys.exit(1)
    for w in warnings:
        print("warning:", w, file=sys.stderr)

    data = {
        "site": {
            "id": site_meta.get("id", os.path.basename(os.path.abspath(instance))),
            "title": site_meta.get("title", "Nuggets"),
            "subtitle": site_meta.get("subtitle", ""),
            "edit-url": site_meta.get("edit-url", ""),
            "body": site_body,
        },
        "nuggets": sorted(nuggets.values(), key=lambda n: n["id"]),
        "groups": sorted(groups.values(), key=lambda g: (g["rank"], g["id"])),
    }

    # output
    os.makedirs(outdir, exist_ok=True)
    web = os.path.join(ENGINE_DIR, "web")
    for fn in os.listdir(web):
        shutil.copy2(os.path.join(web, fn), os.path.join(outdir, fn))
    assets = os.path.join(instance, "assets")
    if os.path.isdir(assets):
        shutil.copytree(assets, os.path.join(outdir, "assets"), dirs_exist_ok=True)
    with open(os.path.join(outdir, "nuggets.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=0)
    open(os.path.join(outdir, ".nojekyll"), "w").close()
    print(f"built {len(nuggets)} nuggets in {len(groups)} groups -> {outdir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    build(sys.argv[1], sys.argv[2])
