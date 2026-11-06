"""FG1 arms as data (copied from AS1's surface_patch.py, as1-2026-11/apparatus/, and extended; changes marked FG1).

FG1 changes, all covered by test_fg1.py (Python and node implementations byte-identical on the pinned scaffold):
- tools.toml is a fourth editable file. Its tool entries are array tables (`[[tools]]`), which AS1's patcher never
  targets; an edit names one entry with the selector table `tools[name=<tool>]` (e.g. `tools[name=bash]`): the body
  of the ONE `[[tools]]` block whose `name = "<tool>"` line matches (zero or two matches is an error). Inside that
  body the same set/insert/verify rules apply as for a plain table; a new key is inserted directly under the
  `[[tools]]` header line (TOML-equivalent anywhere in the block).
- the cell script grants workspace trust for exactly the patched surface, non-interactively, in the cell's own
  HOME (`gnomon trust grant --dir <root>`, the store under $XDG_DATA_HOME or ~/.local/share/gnomon/trust.json),
  after every edit and before `gnomon task`; its output is kept as /logs/agent/fg1-trust-grant.txt and the store's
  listing as fg1-trust-list.txt (no secret is in either: grants name variables, never values). Why: from v0.4.5 a
  key sent to a non-loopback private address (the bridge relay 172.17.0.1) is a grant; untrusted and headless,
  gnomon runs clamped and DROPS api_key_env (and approval = never). See PRE-REGISTRATION §4.
- marker files are fg1-*; surface-tools.toml is copied with the others.

Original AS1 docstring follows.

AS1 arms as data: a TOML fragment per arm -> one deterministic surface patch, plus the per-cell mechanism checks.

A fragment (apparatus/arms/*.toml) declares:

    [arm]     id, family, level, title, hypothesis, evidence, status, branches, requires, cost_factor
    [run]     role (gnomon task --role), task_args (extra `gnomon task` arguments), env (non-secret variables)
    [[edit]]  file (config.toml | roles.toml | policy.toml, under the surface's .gnomon/), table, key,
              value (string, integer, float, boolean or list of strings), op ("set", default, or "delete")
    [[expect]] on (surface | record | wire | stderr), path, op, value, quantifier (wire: all | any),
              severity ("fatal", default: a failure makes the cell an apparatus failure; "warn": reported only,
              for expectations that depend on what the model did rather than on the surface)

A cell's surface = `gnomon init` + P2G's attempt-1 _PATCH + the control fragment + the arm fragment(s), merged here
on the host. Two fragments setting one key to different values is an error, never a silent override.

The merged edits are compiled into ONE `node -e` script (node is in every container: gnomon needs it) that edits the
TOML text line by line, the way H1's HOSTED_PATCH and H3's REPLAY_PATCH did, and refuses (exit 3) unless every edit
landed exactly once in its table. `apply_text` below is the same algorithm in Python: the offline tests run both on
the real v0.4.2 scaffold (fixtures/surface-v042) and require byte-identical output.

Line-level TOML edit rules (both implementations):
- a table is a line `[name]` (whitespace and a trailing comment allowed); array tables `[[...]]` are never targets;
  a table that appears twice is an error;
- its body runs to the next line starting with `[`;
- set: the key's single `key = ...` line in the body is replaced by `key = <literal>`; absent, the line is inserted
  directly under the header; the table absent, `[name]` and the line are appended at the end of the file;
- a key whose current value spans lines (an unclosed `[`, or a triple-quoted string) is an error, not an edit;
- delete: the key's single line is removed; absent is a no-op, recorded;
- role tables (`roles.<role>` in roles.toml) are also applied to every .gnomon/profiles/*.toml that declares the same
  key under the same table, because `role_profile` merges the profile over roles.toml field by field (P1 finding).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import re
import shlex
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARMS_DIR = HERE / "arms"
FILES = ("config.toml", "roles.toml", "policy.toml", "tools.toml")  # FG1: + tools.toml
STATUSES = ("ready", "pending-knob", "pending-build", "absorbed", "optional", "excluded")


class FragmentError(ValueError):
    pass

# ------------------------------------------------------------------------------------------------ fragments


@dataclass
class Fragment:
    id: str
    path: str
    family: str
    level: str
    status: str
    branches: list[str]
    title: str = ""
    requires: list[str] = field(default_factory=list)
    cost_factor: float = 1.0
    role: str | None = None
    task_args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    edits: list[dict] = field(default_factory=list)
    expects: list[dict] = field(default_factory=list)
    raw: dict = field(default_factory=dict)


def _literal(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        return "[" + ", ".join(json.dumps(x, ensure_ascii=False) for x in v) + "]"
    raise FragmentError(f"unsupported value {v!r}: string, integer, float, boolean or list of strings")


def load_fragment(path: Path) -> Fragment:
    raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    arm = raw.get("arm") or {}
    for k in ("id", "family", "status"):
        if k not in arm:
            raise FragmentError(f"{path}: [arm] {k} missing")
    if arm["status"] not in STATUSES:
        raise FragmentError(f"{path}: status {arm['status']!r} not in {STATUSES}")
    run = raw.get("run") or {}
    edits = []
    for e in raw.get("edit") or []:
        op = e.get("op", "set")
        if op not in ("set", "delete"):
            raise FragmentError(f"{path}: edit op {op!r}")
        if e.get("file") not in FILES:
            raise FragmentError(f"{path}: edit file {e.get('file')!r} not in {FILES}")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\[name=[A-Za-z0-9_-]+\]", e.get("table", "")) or not re.fullmatch(r"[A-Za-z0-9_-]+", e.get("key", "")):
            raise FragmentError(f"{path}: bad table/key {e.get('table')!r}/{e.get('key')!r}")
        ed = {"file": e["file"], "table": e["table"], "key": e["key"], "op": op}
        if op == "set":
            if "value" not in e:
                raise FragmentError(f"{path}: set {e['table']}.{e['key']} has no value")
            ed["literal"] = _literal(e["value"])
        edits.append(ed)
    for x in raw.get("expect") or []:
        if x.get("on") not in ("surface", "record", "wire", "stderr"):
            raise FragmentError(f"{path}: expect.on {x.get('on')!r}")
        if x.get("severity", "fatal") not in ("fatal", "warn"):
            raise FragmentError(f"{path}: expect.severity {x.get('severity')!r}")
        if x.get("op", "equals") not in ("equals", "not_equals", "present", "absent", "gt", "contains"):
            raise FragmentError(f"{path}: expect.op {x.get('op')!r}")
    return Fragment(id=arm["id"], path=str(path), family=arm["family"], level=str(arm.get("level", "")),
                    status=arm["status"], branches=list(arm.get("branches", ["A", "B"])), title=arm.get("title", ""),
                    requires=list(arm.get("requires", [])), cost_factor=float(arm.get("cost_factor", 1.0)),
                    role=run.get("role"), task_args=[str(a) for a in run.get("task_args", [])],
                    env={str(k): str(v) for k, v in (run.get("env") or {}).items()}, edits=edits,
                    expects=list(raw.get("expect") or []), raw=raw)


def load_all(arms_dir: Path = ARMS_DIR) -> dict[str, Fragment]:
    out = {}
    for p in sorted(Path(arms_dir).rglob("*.toml")):
        f = load_fragment(p)
        if f.id in out:
            raise FragmentError(f"duplicate arm id {f.id}: {out[f.id].path} and {p}")
        out[f.id] = f
    return out


def merge(frags: list[Fragment]) -> dict:
    """The cell's spec: edits (deduplicated, conflicts refused), run settings and expectations, in fragment order."""
    edits: dict[tuple, dict] = {}
    role, args, env, expects = None, [], {}, []
    for f in frags:
        for e in f.edits:
            k = (e["file"], e["table"], e["key"])
            if k in edits and edits[k] != e:
                raise FragmentError(f"conflict on {k}: {edits[k]} vs {e} ({f.id})")
            edits[k] = e
        if f.role:
            if role and role != f.role:
                raise FragmentError(f"conflicting roles {role} / {f.role} ({f.id})")
            role = f.role
        if f.task_args and f.task_args not in [args[i:i + len(f.task_args)] for i in range(len(args))]:
            args += f.task_args
        for k, v in f.env.items():
            if k in env and env[k] != v:
                raise FragmentError(f"conflicting env {k} ({f.id})")
            env[k] = v
        # Amendment 1: a later fragment's expectation on the same (on, path) replaces an earlier one, so an arm that
        # changes what the control pins (W's window) is checked against its own value, not the control's.
        mine = {(x["on"], x.get("path")) for x in f.expects}
        expects = [x for x in expects if (x["on"], x.get("path")) not in mine]
        expects += [dict(x, arm=f.id) for x in f.expects]
    spec = {"fragments": [f.id for f in frags], "edits": list(edits.values()), "role": role or "implementor",
            "task_args": args, "env": env, "expects": expects}
    spec["sha256"] = spec_hash(spec)
    return spec


def spec_hash(spec: dict) -> str:
    body = {k: v for k, v in spec.items() if k != "sha256"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

# ------------------------------------------------------------------------------------------------ the edit, in Python


_HDR = re.compile(r"^\s*\[([^\[\]]+)\]\s*(#.*)?$")


def _tables(lines: list[str]) -> list[tuple[int, str]]:
    out = []
    for i, l in enumerate(lines):
        if l.lstrip().startswith("[[" ):
            out.append((i, None))  # an array table ends the previous body, is never a target
            continue
        m = _HDR.match(l)
        if m:
            out.append((i, m.group(1).strip()))
    return out


_SEL = re.compile(r"^([A-Za-z0-9_-]+)\[name=([A-Za-z0-9_-]+)\]$")


def _sel_body(lines: list[str], arr: str, name: str) -> tuple[int | None, int]:
    """FG1: the body of the one `[[arr]]` block whose `name = "<name>"` line matches."""
    heads = [i for i, l in enumerate(lines) if l.lstrip().startswith("[")]
    name_re = re.compile(rf'^\s*name\s*=\s*"{re.escape(name)}"\s*(#.*)?$')
    hits = []
    for j, h in enumerate(heads):
        if re.match(rf"^\s*\[\[\s*{re.escape(arr)}\s*\]\]\s*(#.*)?$", lines[h]):
            end = heads[j + 1] if j + 1 < len(heads) else len(lines)
            if any(name_re.match(lines[i]) for i in range(h + 1, end)):
                hits.append((h, end))
    if len(hits) != 1:
        raise FragmentError(f"[[{arr}]] with name = {name!r}: {len(hits)} blocks (need exactly 1)")
    return hits[0]


def _body(lines: list[str], table: str) -> tuple[int | None, int]:
    m = _SEL.match(table)
    if m:
        return _sel_body(lines, m.group(1), m.group(2))
    hs = _tables(lines)
    idx = [i for i, (_, name) in enumerate(hs) if name == table]
    if len(idx) > 1:
        raise FragmentError(f"table [{table}] appears {len(idx)} times")
    if not idx:
        return None, len(lines)
    h = hs[idx[0]][0]
    end = next((hs[j][0] for j in range(idx[0] + 1, len(hs))), len(lines))
    return h, end


def _multiline(rest: str) -> bool:
    v = rest.split("#", 1)[0].strip() if not rest.strip().startswith(('"', "'")) else rest.strip()
    if v.startswith('"""') or v.startswith("'''"):
        return True
    if v.startswith("["):
        depth, q = 0, None
        for ch in v:
            if q:
                if ch == q:
                    q = None
                continue
            if ch in "\"'":
                q = ch
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
        return depth > 0
    return False


def apply_text(text: str, edits: list[dict]) -> tuple[str, list[dict]]:
    """Apply set/delete edits to one TOML file's text. Returns the new text and one action record per edit."""
    trail_nl = text.endswith("\n")
    lines = text.split("\n")
    if trail_nl:
        lines = lines[:-1]
    actions = []
    for e in edits:
        h, end = _body(lines, e["table"])
        key_re = re.compile(rf"^\s*{re.escape(e['key'])}\s*=(.*)$")
        hits = [i for i in range(h + 1, end) if key_re.match(lines[i])] if h is not None else []
        if len(hits) > 1:
            raise FragmentError(f"[{e['table']}] {e['key']} appears {len(hits)} times")
        if hits and _multiline(key_re.match(lines[hits[0]]).group(1)):
            raise FragmentError(f"[{e['table']}] {e['key']} spans lines; not editable here")
        new = f"{e['key']} = {e['literal']}" if e["op"] == "set" else None
        if e["op"] == "delete":
            if hits:
                del lines[hits[0]]
                actions.append({**_k(e), "action": "deleted"})
            else:
                actions.append({**_k(e), "action": "absent"})
        elif hits:
            lines[hits[0]] = new
            actions.append({**_k(e), "action": "replaced"})
        elif h is not None:
            lines.insert(h + 1, new)
            actions.append({**_k(e), "action": "inserted"})
        else:
            if lines and lines[-1].strip():
                lines.append("")
            lines += [f"[{e['table']}]", new]
            actions.append({**_k(e), "action": "table-added"})
    for e in edits:  # verify: each set line present exactly once in its table, each delete absent
        h, end = _body(lines, e["table"])
        key_re = re.compile(rf"^\s*{re.escape(e['key'])}\s*=")
        hits = [i for i in range(h + 1, end) if key_re.match(lines[i])] if h is not None else []
        if e["op"] == "set" and not (len(hits) == 1 and lines[hits[0]] == f"{e['key']} = {e['literal']}"):
            raise FragmentError(f"verify: [{e['table']}] {e['key']} not set exactly once")
        if e["op"] == "delete" and hits:
            raise FragmentError(f"verify: [{e['table']}] {e['key']} still present")
    out = "\n".join(lines) + ("\n" if trail_nl else "")
    return out, actions


def _k(e):
    return {"file": e["file"], "table": e["table"], "key": e["key"], "op": e["op"]}


def profile_targets(edits: list[dict], profiles: dict[str, str]) -> dict[str, list[dict]]:
    """Role-table edits in roles.toml that a profile overrides: {profile name: [edits]}."""
    out: dict[str, list[dict]] = {}
    for e in edits:
        if e["file"] != "roles.toml" or not e["table"].startswith("roles."):
            continue
        for name, text in sorted(profiles.items()):
            lines = text.split("\n")
            h, end = _body(lines, e["table"])
            if h is None:
                continue
            key_re = re.compile(rf"^\s*{re.escape(e['key'])}\s*=")
            if any(key_re.match(lines[i]) for i in range(h + 1, end)):
                out.setdefault(name, []).append(e)
    return out


def apply_surface(files: dict[str, str], profiles: dict[str, str], edits: list[dict]) -> tuple[dict, dict, list]:
    """The whole patch on in-memory files: {name: text} for config/roles/policy and the profiles."""
    files, profiles = dict(files), dict(profiles)
    actions = []
    for name in FILES:
        es = [e for e in edits if e["file"] == name]
        if es:
            files[name], a = apply_text(files.get(name, ""), es)
            actions += a
    for name, es in profile_targets(edits, profiles).items():
        profiles[name], a = apply_text(profiles[name], [dict(e, op=e["op"]) for e in es])
        actions += [dict(x, file=f"profiles/{name}") for x in a]
    return files, profiles, actions

# ------------------------------------------------------------------------------------------------ the edit, in node

_JS = r"""
const fs = require("fs"), path = require("path");
const ROOT = process.argv[1] || ".";
const EDITS = JSON.parse(__EDITS__);
class E extends Error {}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HDR = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/;
function tables(L) { const o = []; L.forEach((l, i) => { if (l.trimStart().startsWith("[[")) { o.push([i, null]); return; }
  const m = HDR.exec(l); if (m) o.push([i, m[1].trim()]); }); return o; }
const SEL = /^([A-Za-z0-9_-]+)\[name=([A-Za-z0-9_-]+)\]$/;
function selBody(L, arr, name) { const heads = []; L.forEach((l, i) => { if (l.trimStart().startsWith("[")) heads.push(i); });
  const nr = new RegExp(`^\\s*name\\s*=\\s*"${esc(name)}"\\s*(#.*)?$`); const ar = new RegExp(`^\\s*\\[\\[\\s*${esc(arr)}\\s*\\]\\]\\s*(#.*)?$`);
  const hits = []; heads.forEach((h, j) => { if (!ar.test(L[h])) return; const end = j + 1 < heads.length ? heads[j + 1] : L.length;
    for (let i = h + 1; i < end; i++) if (nr.test(L[i])) { hits.push([h, end]); break; } });
  if (hits.length !== 1) throw new E(`[[${arr}]] with name = '${name}': ${hits.length} blocks (need exactly 1)`); return hits[0]; }
function body(L, t) { const sm = SEL.exec(t); if (sm) return selBody(L, sm[1], sm[2]); const hs = tables(L); const idx = []; hs.forEach(([, n], j) => { if (n === t) idx.push(j); });
  if (idx.length > 1) throw new E(`table [${t}] appears ${idx.length} times`); if (!idx.length) return [null, L.length];
  const h = hs[idx[0]][0]; const nx = hs[idx[0] + 1]; return [h, nx ? nx[0] : L.length]; }
function multiline(rest) { const r = rest.trim(); const v = (r.startsWith('"') || r.startsWith("'")) ? r : rest.split("#", 1)[0].trim();
  if (v.startsWith('\x22\x22\x22') || v.startsWith("\x27\x27\x27")) return true;
  if (v.startsWith("[")) { let d = 0, q = null; for (const ch of v) { if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch; else if (ch === "[") d++; else if (ch === "]") d--; } return d > 0; } return false; }
function apply(text, edits) {
  const nl = text.endsWith("\n"); let L = text.split("\n"); if (nl) L = L.slice(0, -1); const acts = [];
  for (const e of edits) {
    const [h, end] = body(L, e.table); const kr = new RegExp(`^\\s*${esc(e.key)}\\s*=(.*)$`);
    const hits = []; if (h !== null) for (let i = h + 1; i < end; i++) if (kr.test(L[i])) hits.push(i);
    if (hits.length > 1) throw new E(`[${e.table}] ${e.key} appears ${hits.length} times`);
    if (hits.length && multiline(kr.exec(L[hits[0]])[1])) throw new E(`[${e.table}] ${e.key} spans lines`);
    const line = `${e.key} = ${e.literal}`; const k = { file: e.file, table: e.table, key: e.key, op: e.op };
    if (e.op === "delete") { if (hits.length) { L.splice(hits[0], 1); acts.push({ ...k, action: "deleted" }); } else acts.push({ ...k, action: "absent" }); }
    else if (hits.length) { L[hits[0]] = line; acts.push({ ...k, action: "replaced" }); }
    else if (h !== null) { L.splice(h + 1, 0, line); acts.push({ ...k, action: "inserted" }); }
    else { if (L.length && L[L.length - 1].trim()) L.push(""); L.push(`[${e.table}]`, line); acts.push({ ...k, action: "table-added" }); }
  }
  for (const e of edits) { const [h, end] = body(L, e.table); const kr = new RegExp(`^\\s*${esc(e.key)}\\s*=`);
    const hits = []; if (h !== null) for (let i = h + 1; i < end; i++) if (kr.test(L[i])) hits.push(i);
    if (e.op === "set" && !(hits.length === 1 && L[hits[0]] === `${e.key} = ${e.literal}`)) throw new E(`verify: [${e.table}] ${e.key} not set exactly once`);
    if (e.op === "delete" && hits.length) throw new E(`verify: [${e.table}] ${e.key} still present`); }
  return [L.join("\n") + (nl ? "\n" : ""), acts];
}
try {
  const G = path.join(ROOT, ".gnomon"); const acts = []; const out = {};
  for (const f of ["config.toml", "roles.toml", "policy.toml", "tools.toml"]) { const es = EDITS.filter((e) => e.file === f); if (!es.length) continue;
    const p = path.join(G, f); const [t, a] = apply(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "", es); out[p] = t; acts.push(...a); }
  const pd = path.join(G, "profiles");
  if (fs.existsSync(pd)) for (const f of fs.readdirSync(pd).filter((x) => x.endsWith(".toml")).sort()) {
    const p = path.join(pd, f); const txt = fs.readFileSync(p, "utf8"); const L = txt.split("\n");
    const es = EDITS.filter((e) => e.file === "roles.toml" && e.table.startsWith("roles.") && (() => { const [h, end] = body(L, e.table);
      if (h === null) return false; const kr = new RegExp(`^\\s*${esc(e.key)}\\s*=`); for (let i = h + 1; i < end; i++) if (kr.test(L[i])) return true; return false; })());
    if (!es.length) continue; const [t, a] = apply(txt, es); out[p] = t; acts.push(...a.map((x) => ({ ...x, file: `profiles/${f}` }))); }
  for (const [p, t] of Object.entries(out)) fs.writeFileSync(p, t);
  console.log(JSON.stringify({ ok: true, spec: __SHA__, actions: acts }));
} catch (err) { console.log(JSON.stringify({ ok: false, spec: __SHA__, error: String(err.message || err) })); process.exit(3); }
"""


def compile_js(spec: dict) -> str:
    """The `node -e` program for this spec. argv[1] is the directory that holds .gnomon/."""
    edits = [{k: e[k] for k in ("file", "table", "key", "op", "literal") if k in e} for e in spec["edits"]]
    return (_JS.replace("__EDITS__", json.dumps(json.dumps(edits, ensure_ascii=False)))
               .replace("__SHA__", json.dumps(spec["sha256"])))

# ------------------------------------------------------------------------------------------------ the cell script


def run_script(spec: dict, instruction: str, p2g_patch: str, trust_grant: bool = True) -> str:
    """The shell script GnomonFG1.run() hands to Harbor (p2g_patch = P2G's attempt-1 _PATCH). Pure, and free of
    Harbor imports, so the offline tests and wiretest_fg1.py check exactly the script a cell runs.
    FG1: + the trust grant of the patched surface (fatal if it fails) and surface-tools.toml."""
    js = compile_js(spec)
    env = " ".join(f"{k}={shlex.quote(v)}" for k, v in sorted(spec["env"].items()))
    task = (f"{'env ' + env + ' ' if env else ''}gnomon task {shlex.quote(instruction)} --role {shlex.quote(spec['role'])} "
            + "".join(f"{shlex.quote(a)} " for a in spec["task_args"]) + "--yes --json")
    root = (
        'GN_ROOT=.; if [ ! -f .gnomon/config.toml ]; then '
        'for d in "${XDG_STATE_HOME:-$HOME/.local/state}"/gnomon/workdirs/*/; do '
        '[ -f "$d.gnomon/config.toml" ] && GN_ROOT="${d%/}"; done; fi; '
        'echo "$GN_ROOT" > /logs/agent/fg1-surface-root.txt; '
    )
    return (
        ". ~/.nvm/nvm.sh; set -u; "
        "cp $HOME/.gnomon-release /logs/agent/gnomon-release.txt; "
        "gnomon --version > /logs/agent/gnomon-version.txt 2>&1 || true; "
        "gnomon init >/dev/null 2>&1 || true; "
        + root +
        f"( cd \"$GN_ROOT\" && node -e {shlex.quote(p2g_patch)} ) || {{ echo 'P2G _PATCH failed' > /logs/agent/fg1-patch-failed.txt; exit 3; }}; "
        f"node -e {shlex.quote(js)} \"$GN_ROOT\" > /logs/agent/fg1-surface-patch.json "
        "|| { echo 'FG1 surface patch failed' > /logs/agent/fg1-patch-failed.txt; exit 3; }; "
        f"echo {shlex.quote(json.dumps({'spec': spec['sha256'], 'fragments': spec['fragments']}))} > /logs/agent/fg1-spec.json; "
        'cp "$GN_ROOT/.gnomon/config.toml" /logs/agent/surface-config.toml; '
        'cp "$GN_ROOT/.gnomon/roles.toml" /logs/agent/surface-roles.toml; '
        'cp "$GN_ROOT/.gnomon/policy.toml" /logs/agent/surface-policy.toml 2>/dev/null || true; '
        'cp "$GN_ROOT/.gnomon/tools.toml" /logs/agent/surface-tools.toml 2>/dev/null || true; '
        # FG1: trust exactly this surface, in this cell's HOME, before the task (PRE-REGISTRATION §4)
        + (('gnomon trust grant --dir "$GN_ROOT" > /logs/agent/fg1-trust-grant.txt 2>&1 '
            "|| { echo 'FG1 trust grant failed' > /logs/agent/fg1-patch-failed.txt; exit 3; }; "
            'gnomon trust list --dir "$GN_ROOT" > /logs/agent/fg1-trust-list.txt 2>&1 || true; ')
           if trust_grant else "") +  # False only in the wire test's negative control
        'mkdir -p /logs/agent/surface-profiles; cp "$GN_ROOT"/.gnomon/profiles/*.toml /logs/agent/surface-profiles/ 2>/dev/null || true; '
        "mkdir -p /logs/agent/audit-live; "
        '( while sleep 20; do for a in "$GN_ROOT/.gnomon-audit" ./.gnomon-audit; do '
        '[ -d "$a" ] && cp -r "$a/." /logs/agent/audit-live/ 2>/dev/null; done; done ) & '
        "GN_COPIER=$!; "
        f"{task} > /logs/agent/gnomon-task.json 2> /logs/agent/gnomon-stderr.log; "
        "echo $? > /logs/agent/gnomon-exit.txt; "
        "kill $GN_COPIER 2>/dev/null || true; "
        'for a in "$GN_ROOT/.gnomon-audit" ./.gnomon-audit; do [ -d "$a" ] && cp -r "$a" /logs/agent/audit 2>/dev/null && break; done; '
        "exit 0"
    )


# ------------------------------------------------------------------------------------------------ mechanism checks


def _get(obj, path: str):
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return _MISSING
    return cur


def _select(doc: dict) -> dict:
    """FG1: expose array-table entries by name, so a path can read `tools[name=bash].soft_timeout`."""
    out = dict(doc)
    for k, v in doc.items():
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            for x in v:
                if isinstance(x.get("name"), str):
                    out[f"{k}[name={x['name']}]"] = x
    return out


class _Missing:
    def __repr__(self):
        return "<missing>"


_MISSING = _Missing()


def _test(v, op: str, want) -> bool:
    if op == "present":
        return v is not _MISSING and v is not None
    if op == "absent":
        return v is _MISSING or v is None
    if v is _MISSING:
        return False
    if op == "equals":
        return v == want
    if op == "not_equals":
        return v != want
    if op == "gt":
        return isinstance(v, (int, float)) and v > want
    if op == "contains":
        return want in v
    raise FragmentError(f"expect op {op!r}")


def check_cell(expects: list[dict], agent_dir: Path | None, wire_dir: Path | None) -> list[dict]:
    """Each expectation -> pass | fail | unverifiable. Only a 'fail' (positive evidence the surface or the request
    is not what the arm declares) makes a cell an apparatus failure; a capped run with no final record is
    'unverifiable' on its record expectations, never a failure."""
    out = []
    rec = surf = stderr = None
    bodies = None
    for x in expects:
        on, path, op, want = x["on"], x.get("path", ""), x.get("op", "equals"), x.get("value")
        res, detail = "unverifiable", ""
        try:
            if on == "record":
                if rec is None and agent_dir is not None and (agent_dir / "gnomon-task.json").exists():
                    rec = json.loads((agent_dir / "gnomon-task.json").read_text(encoding="utf-8"))
                if rec is not None:
                    v = _get(rec, path)
                    res, detail = ("pass" if _test(v, op, want) else "fail"), f"{path} = {v!r}"
            elif on == "surface":
                f, tp = path.split(":", 1)
                p = agent_dir / {"config.toml": "surface-config.toml", "roles.toml": "surface-roles.toml",
                                 "policy.toml": "surface-policy.toml", "tools.toml": "surface-tools.toml"}[f] if agent_dir else None
                if p is not None and p.exists():
                    v = _get(_select(tomllib.loads(p.read_text(encoding="utf-8"))), tp)
                    res, detail = ("pass" if _test(v, op, want) else "fail"), f"{path} = {v!r}"
            elif on == "stderr":
                p = agent_dir / "gnomon-stderr.log" if agent_dir else None
                if p is not None and p.exists():
                    hit = re.search(want, p.read_text(encoding="utf-8", errors="replace")) is not None
                    res = "pass" if hit == (op == "contains") else "fail"
                    detail = f"/{want}/ {'found' if hit else 'not found'}"
            elif on == "wire":
                if bodies is None and wire_dir is not None:
                    bodies = []
                    for g in sorted(Path(wire_dir).glob("req-*.json.gz")):
                        try:
                            bodies.append(json.loads(gzip.decompress(g.read_bytes())))
                        except Exception:
                            pass
                if bodies:
                    q = x.get("quantifier", "all")
                    hits = [_test(_get(b, path), op, want) for b in bodies]
                    ok = all(hits) if q == "all" else any(hits)
                    res, detail = ("pass" if ok else "fail"), f"{sum(hits)}/{len(hits)} requests"
        except Exception as e:  # a malformed log is not the arm's failure
            res, detail = "unverifiable", f"{type(e).__name__}: {e}"
        out.append({"arm": x.get("arm"), "on": on, "path": path, "op": op, "value": want, "result": res,
                    "severity": x.get("severity", "fatal"), "detail": detail})
    return out


def mechanism_failed(results: list[dict]) -> list[dict]:
    """The fatal expectations that failed: a non-empty list makes the cell an apparatus failure."""
    return [r for r in results if r["result"] == "fail" and r["severity"] == "fatal"]
