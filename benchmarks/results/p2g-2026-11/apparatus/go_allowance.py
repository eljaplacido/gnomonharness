"""Go allowance guard and account record, shared by every runner that spends OpenCode Go through relay-go.mjs
(AS1 run_as1.py, FG1 run_fg1.py and FG1's hub lane). Added 2026-11-07 (AS1 Amendment 3, FG1 Amendment 4). Apparatus
only: it decides WHEN a wave may start, never which wave, and never changes a cell.

How Go reports an exhausted allowance (found in opencode 1.18.32's own client, not guessed):
  - a retryable HTTP error whose body contains "GoUsageLimitError", with JSON metadata.limitName (which window: the
    5-hour, weekly or monthly one) and metadata.workspace, and a `retry-after` header (seconds until that window
    resets). opencode shows it as "Go limit reached: <limitName> usage limit reached. It will reset in ...".
  - NOT the same as `429 {"error":{"type":"server_error","message":"Upstream request failed: [overloaded] ..."}}`,
    which is the provider being busy and says nothing about the account.
  - with Extra Usage on (and a Console balance), Go does not refuse but bills the balance: the response's
    usage.opencode.billing_source becomes "balance" (and `cost` > 0) instead of the plan's label ("go" / "go-plus").
    That is real money, so it is treated exactly like exhaustion.
Go exposes no remaining-allowance API (docs: track usage in the Console). The remaining allowance is therefore
METERED here: a baseline the operator reads off the Console (ACCOUNTS.json) minus everything the relays have counted
since (each relay's /counters `allowance`, summed with restart detection), plus a rolling 5-hour sum.
Limits for deepseek-v4.1-flash (opencode.ai/docs/go): monthly Go $100 / Go Plus $200; 5-hour = 20 %, weekly = 50 %.

API for runners:
  acct = wave_gate(study, wave_id, margin_usd)       -> blocks while paused; registers the wave in flight; returns the
                                                       account label to record per cell (covariate)
  wave_done(study, wave_id)                           -> after the wave's cells are scored
  scan_cell(wire_dir) -> dict                         -> {"exhausted": reason|None, "billing": {...}, "list_usd", ...}
                                                         a cell with exhausted != None is apparatus-invalid (re-run)
  flag_exhausted(reason, where)                       -> sets the pause flag for the current account
CLI: python3 go_allowance.py status | meter | init-baseline ...
"""
from __future__ import annotations

import datetime as dt
import fcntl
import gzip
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
DIR = Path(os.environ.get("GO_ACCOUNTS_DIR") or REPO / "benchmarks" / "results" / "go-accounts-2026-11")
ACCOUNTS = DIR / "ACCOUNTS.json"        # committed: labels, auth-file PATHS (never contents), plan, baseline
METER = DIR / "meter.json"              # committed at switches; updated at every gate
EVENTS = DIR / "events.jsonl"           # PAUSED / RESUMED / EXHAUSTED / SWITCH lines (committed)
FLAG = DIR / "EXHAUSTED.json"           # present = the current account is exhausted (or billing a balance)
SWITCHING = DIR / "SWITCHING"           # present = switch_go_account.sh is between waves restarting relays
INFLIGHT = DIR / "inflight"             # one file per wave in flight (pid inside)
LOCK = DIR / ".lock"
STATUS_FILES = [] if os.environ.get("GO_ACCOUNTS_DIR") else [  # a test dir never writes the studies' STATUS
    REPO / "benchmarks" / "results" / s / "STATUS.txt" for s in ("as1-2026-11", "fg1-2026-11")]
COUNTER_PORTS = range(4810, 4820)       # relay slots 0-9 (0-5 gx10 docker bridge, 6-8 hub lane on Tailscale)
POLL_S = 120
# deepseek-v4.1-flash, opencode.ai/docs/go: monthly limit per plan; 5h = 20 %, weekly = 50 %
LIMITS = {"go": {"monthly": 100.0}, "go-plus": {"monthly": 200.0}}
for _p in LIMITS.values():
    _p["5h"], _p["weekly"] = 0.2 * _p["monthly"], 0.5 * _p["monthly"]


def utc(t: float | None = None) -> str:
    return dt.datetime.fromtimestamp(time.time() if t is None else t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save(p: Path, obj) -> None:
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, p)


class _Locked:
    def __enter__(self):
        DIR.mkdir(parents=True, exist_ok=True)
        self.f = open(LOCK, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def event(kind: str, msg: str, status: bool = True, **extra) -> None:
    line = f"{utc()} {kind}: {msg}"
    with open(EVENTS, "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": utc(), "kind": kind, "msg": msg, **extra}) + "\n")
    if status:
        for s in STATUS_FILES:
            try:
                with open(s, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass


def accounts() -> dict:
    return _load(ACCOUNTS, {})


def current() -> tuple[str, dict]:
    a = accounts()
    lab = a.get("current")
    return lab, (a.get("accounts") or {}).get(lab, {})


def _counters(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/counters", timeout=5) as r:
            return json.load(r)
    except Exception:
        return None


def meter_update() -> dict:
    """Fold every relay's allowance counter into the meter of the current account (caller holds the lock). A relay
    whose `requests` went DOWN was restarted: its whole current allowance is new spend. Spend between a relay's last
    reading and an unplanned restart is lost (bounded by one gate interval); switch_go_account.sh reads the counters
    right before it restarts anything."""
    lab, _ = current()
    m = _load(METER, {})
    if m.get("account") != lab:
        m = {"account": lab, "since": utc(), "spent_usd": 0.0, "list_usd": 0.0, "relays": {}, "events": []}
    now = time.time()
    add = add_list = 0.0
    for port in COUNTER_PORTS:
        c = _counters(port)
        if c is None:
            continue
        last = m["relays"].get(str(port))
        a, rq = float(c.get("allowance") or 0), int(c.get("requests") or 0)
        if last is None and not m.get("_seeded"):
            d = 0.0  # first sight at init: the baseline already includes it
        elif last is None or rq < last["requests"] or a < last["allowance"] - 1e-12:
            d = a
        else:
            d = a - last["allowance"]
        gul, bal = int(c.get("go_usage_limit") or 0), int((c.get("billing_sources") or {}).get("balance") or 0)
        restarted = last is not None and rq < last["requests"]
        g0 = 0 if (last is None or restarted) else int(last.get("go_usage_limit", 0))
        b0 = 0 if (last is None or restarted) else int(last.get("balance", 0))
        if gul > g0:
            _set_flag(lab, f"relay reported GoUsageLimitError ({(c.get('last_go_limit') or {}).get('limitName')}, "
                           f"retry-after {(c.get('last_go_limit') or {}).get('retry_after')} s)", f"counters :{port}")
        if bal > b0:
            _set_flag(lab, "relay saw billing_source 'balance' (Extra Usage is billing the Console balance)",
                      f"counters :{port}")
        m["relays"][str(port)] = {"requests": rq, "allowance": a, "go_usage_limit": gul, "balance": bal, "t": utc(now)}
        add += max(0.0, d)
    m["_seeded"] = True
    if add > 0:
        m["spent_usd"] = round(m["spent_usd"] + add, 8)
        m["events"].append([round(now), round(add, 8)])
    m["events"] = [e for e in m["events"] if e[0] > now - 8 * 86400]
    m["updated"] = utc(now)
    _save(METER, m)
    return m


def headroom(m: dict | None = None) -> dict:
    """Remaining allowance of the current account per window, from the operator's baseline and the meter."""
    lab, acct = current()
    m = m or _load(METER, {})
    lim = LIMITS.get(acct.get("plan", "go"), LIMITS["go"])
    base = acct.get("baseline") or {}
    spent = float(m.get("spent_usd", 0.0)) if m.get("account") == lab else 0.0
    now = time.time()
    s5 = sum(e[1] for e in (m.get("events") or []) if e[0] > now - 5 * 3600)
    s5 += float(base.get("spent_5h_usd_at_baseline", 0.0)) if now - base.get("t_epoch", 0) < 5 * 3600 else 0.0
    out = {"account": lab, "plan": acct.get("plan"), "spent_since_baseline": round(spent, 4),
           "5h": round(lim["5h"] - s5, 4)}
    for w in ("weekly", "monthly"):
        r = base.get(f"{w}_remaining_usd")
        out[w] = round(float(r) - spent, 4) if r is not None else None
    return out


def _inflight(exclude: str | None = None) -> list[dict]:
    INFLIGHT.mkdir(parents=True, exist_ok=True)
    out = []
    for f in INFLIGHT.glob("*.json"):
        d = _load(f, {})
        if not d or not os.path.exists(f"/proc/{d.get('pid', 0)}"):
            f.unlink(missing_ok=True)  # its runner is gone: nothing in flight
            continue
        if f.stem != exclude:
            out.append(d)
    return out


def blockers(margin_usd: float, key: str | None = None) -> list[str]:
    """Why a wave may not start now (empty = it may). Caller holds the lock."""
    why = []
    lab, acct = current()
    if not lab or not acct:
        return ["no current account in ACCOUNTS.json"]
    if SWITCHING.exists():
        why.append("account switch in progress")
    if FLAG.exists():
        f = _load(FLAG, {})
        if f.get("account") == lab:
            why.append(f"{lab} exhausted: {f.get('reason')}")
    if acct.get("probe_ok") is False:
        why.append(f"{lab}: the switch probe did not pass")
    m = meter_update()
    h = headroom(m)
    need = margin_usd + sum(float(d.get("margin_usd", 0)) for d in _inflight(exclude=key))
    for w in ("5h", "weekly", "monthly"):
        if h[w] is not None and h[w] < need:
            why.append(f"{lab} {w} headroom ${h[w]:.2f} < ${need:.2f} (this wave's margin + waves in flight)")
    return why


def wave_gate(study: str, wave_id: str, margin_usd: float) -> str:
    """Block until a wave may start; register it in flight (one entry per study lane, so a wave that died before
    wave_done() is replaced by the lane's next wave, never leaked); return the account label."""
    key = study
    paused_msg = None
    while True:
        with _Locked():
            why = blockers(margin_usd, key)
            if not why:
                INFLIGHT.mkdir(parents=True, exist_ok=True)
                lab, _ = current()
                _save(INFLIGHT / f"{key}.json", {"study": study, "wave": wave_id, "pid": os.getpid(),
                                                 "margin_usd": margin_usd, "account": lab, "t": utc()})
                if paused_msg:
                    event("RESUMED", f"Go allowance — {study} wave {wave_id} starts on {lab} ({headroom()})")
                return lab
            msg = "; ".join(why)
        if msg != paused_msg:
            event("PAUSED", f"Go allowance — {study} wave {wave_id} not started: {msg}. Nothing runs until "
                  f"switch_go_account.sh (or a corrected ACCOUNTS.json baseline) clears it.")
            print(f"{utc()} PAUSED: Go allowance — {msg}", flush=True)
            paused_msg = msg
        time.sleep(POLL_S)


def wave_done(study: str, wave_id: str) -> None:
    with _Locked():
        f = INFLIGHT / f"{study}.json"
        if _load(f, {}).get("wave") == wave_id:
            f.unlink(missing_ok=True)
        meter_update()


def _set_flag(lab: str, reason: str, where: str) -> None:
    """Caller holds the lock."""
    if FLAG.exists() and _load(FLAG, {}).get("account") == lab:
        return
    _save(FLAG, {"account": lab, "reason": reason, "where": where, "t": utc()})
    event("EXHAUSTED", f"Go allowance — {lab}: {reason} ({where}); no new wave starts on {lab}")


def flag_exhausted(reason: str, where: str) -> None:
    with _Locked():
        _set_flag(current()[0], reason, where)


def scan_cell(wire: Path) -> dict:
    """Read a cell's wire (log-relay calls.jsonl + resp-NNNN.sse.gz): exhaustion, billing labels, list cost."""
    out = {"exhausted": None, "billing": {}, "list_usd": 0.0, "models": {}, "overloaded_429": 0}
    f = wire / "calls.jsonl"
    if not f.exists():
        return out
    _, acct = current()
    expect = acct.get("billing_label")
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            r = json.loads(line)
        except Exception:
            continue
        st = r.get("status")
        u = ((r.get("resp") or {}).get("usage") or {})
        oc = u.get("opencode") or {}
        if oc.get("billing_source"):
            b = oc["billing_source"]
            out["billing"][b] = out["billing"].get(b, 0) + 1
            if b == "balance" or (u.get("cost") or 0) > 0:
                out["exhausted"] = out["exhausted"] or f"billed to the Console balance (billing_source {b})"
        out["list_usd"] += float(oc.get("list_cost") or 0)
        if isinstance(st, int) and st >= 400:
            p = wire / f"resp-{int(r.get('n', 0)):04d}.sse.gz"
            try:
                body = gzip.decompress(p.read_bytes()).decode("utf-8", "replace") if p.exists() else ""
            except Exception:
                body = ""
            if "GoUsageLimitError" in body:
                name = None
                try:
                    name = (json.loads(body).get("metadata") or {}).get("limitName")
                except Exception:
                    pass
                out["exhausted"] = f"GoUsageLimitError ({name or 'limit'}) at call {r.get('n')}"
            elif "overloaded" in body:
                out["overloaded_429"] += 1
    if expect and out["billing"] and set(out["billing"]) - {expect}:
        out["exhausted"] = out["exhausted"] or f"unexpected billing_source {sorted(out['billing'])} (expected {expect})"
    out["list_usd"] = round(out["list_usd"], 6)
    return out


# ------------------------------------------------------------------------------------------------ account switch
RELAY_SCRIPT = "apparatus/relay-go.mjs"
SWITCHES = DIR / "switches.jsonl"
PROBE_BODY = {"model": "deepseek-v4.1-flash", "stream": False, "temperature": 0, "max_tokens": 16,
              "messages": [{"role": "user", "content": "Reply with exactly the word: ok"}]}
# Only these variables are carried over from a running relay (read from /proc/<pid>/environ; nothing else is read or
# printed). RELAY_AUTH_FILE is a path; the key stays inside the relay process.
RELAY_VARS = ("RELAY_BIND", "RELAY_PORT", "RELAY_COUNTERS_PORT", "RELAY_UPSTREAM", "RELAY_PROVIDER", "RELAY_LABEL",
              "RELAY_KEY_NAME", "RELAY_AUTH_FILE")


def relays(only_ports: set[int] | None = None) -> list[dict]:
    """Every running relay-go.mjs, with exactly what it was started with: cwd, RELAY_* env, stdout file."""
    out = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            argv = (d / "cmdline").read_bytes().split(b"\0")
            if [a.decode() for a in argv if a][:2] != ["node", RELAY_SCRIPT] and not (
                    len(argv) > 1 and argv[1].decode().endswith("/relay-go.mjs")):
                continue
            env = {}
            for kv in (d / "environ").read_bytes().split(b"\0"):
                k, _, v = kv.decode("utf-8", "replace").partition("=")
                if k in RELAY_VARS:
                    env[k] = v
            r = {"pid": int(d.name), "argv": [a.decode() for a in argv if a], "cwd": os.readlink(d / "cwd"),
                 "env": env, "log": os.readlink(d / "fd" / "1")}
        except (OSError, PermissionError):
            continue
        if only_ports and int(env.get("RELAY_COUNTERS_PORT", 0)) not in only_ports:
            continue
        out.append(r)
    return sorted(out, key=lambda r: int(r["env"].get("RELAY_PORT", 0)))


def _unsettled(c: dict) -> float:
    return c.get("chat_requests", 0) - sum(c.get(k, 0) for k in ("responses_with_usage", "responses_without_usage",
                                                                     "responses_compressed", "status_4xx", "status_5xx",
                                                                     "errors"))


def _listening(port: int) -> bool:
    return _counters(port) is not None


def _start(r: dict, auth_file: str, note: str) -> int:
    import subprocess
    env = {k: v for k, v in os.environ.items() if not k.startswith("RELAY_")}
    env.update({**r["env"], "RELAY_AUTH_FILE": auth_file})
    with open(r["log"], "a", encoding="utf-8") as log:
        log.write(f"--- {note} {utc()}\n")
        log.flush()
        p = subprocess.Popen(r["argv"], cwd=r["cwd"], env=env, stdout=log, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
    return p.pid


def _stop(pid: int) -> None:
    import signal
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        if not os.path.exists(f"/proc/{pid}"):
            return
        time.sleep(0.2)
    os.kill(pid, signal.SIGKILL)


def probe(r: dict, tag: str, tries: int = 12) -> dict:
    """One tiny request through the relay; retries only on 429 [overloaded]."""
    import urllib.error
    url = f"http://{r['env'].get('RELAY_BIND', '127.0.0.1')}:{r['env']['RELAY_PORT']}/openai/v1/chat/completions"
    res = {}
    for i in range(tries):
        req = urllib.request.Request(url, data=json.dumps(PROBE_BODY).encode(), method="POST", headers={
            "content-type": "application/json", "authorization": "Bearer p2g-relay-placeholder",
            "user-agent": "gnomon-go-account-switch/1 (one probe per relay slot)",
            "x-opencode-session": f"go-switch-{tag}-{r['env']['RELAY_PORT']}-{i}"})
        t = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                j = json.load(resp)
            oc = ((j.get("usage") or {}).get("opencode") or {})
            res = {"status": 200, "tries": i + 1, "wall_ms": int((time.time() - t) * 1000), "model": j.get("model"),
                   "billing_source": oc.get("billing_source"), "list_cost": oc.get("list_cost"),
                   "allowance": oc.get("allowance"), "cost": (j.get("usage") or {}).get("cost"),
                   "allowance_per_list": round(oc["allowance"] / oc["list_cost"], 4)
                   if oc.get("allowance") and oc.get("list_cost") else None}
            return res
        except urllib.error.HTTPError as e:
            body = e.read()[:400].decode("utf-8", "replace")
            res = {"status": e.code, "tries": i + 1, "body": body,
                   "kind": "GoUsageLimitError" if "GoUsageLimitError" in body else
                   "overloaded" if "overloaded" in body else "other"}
            if res["kind"] != "overloaded":
                return res
        except Exception as e:
            res = {"status": None, "tries": i + 1, "error": repr(e)[:200]}
        time.sleep(30)
    return res


def switch(auth_file: str, label: str, plan: str, weekly: float | None, wait_max_s: float, dry: bool,
           only_ports: set[int] | None) -> int:
    old_lab, old = current()
    # the relays to move = every relay-go.mjs running on the current account's auth file (slots 0-5, the hub lane's
    # 6-8, any other study's relay on the same account); a relay on another auth file is not touched
    rs = [r for r in relays(only_ports) if only_ports or r["env"].get("RELAY_AUTH_FILE") == old.get("auth_file")]
    print(f"{utc()} switch {old_lab} -> {label} ({plan}); auth file {auth_file}; {len(rs)} relay(s):")
    for r in rs:
        e = r["env"]
        print(f"  pid {r['pid']} {e.get('RELAY_BIND')}:{e.get('RELAY_PORT')} counters {e.get('RELAY_COUNTERS_PORT')} "
              f"auth {e.get('RELAY_AUTH_FILE')} cwd {r['cwd']} log {r['log']}")
        print(f"    restart: cd {r['cwd']} && " + " ".join(f"{k}={v}" for k, v in sorted(e.items())
              if k != "RELAY_AUTH_FILE") + f" RELAY_AUTH_FILE={auth_file} setsid nohup {' '.join(r['argv'])} "
              f">> {r['log']} 2>&1 < /dev/null &")
    if not os.path.isfile(auth_file) or os.path.getsize(auth_file) == 0:
        print(f"refusing: {auth_file} is missing or empty (log the account in first)")
        return 2
    if plan not in LIMITS:
        print(f"refusing: plan {plan!r} not in {sorted(LIMITS)}")
        return 2
    if not rs:
        print("refusing: no running relay-go.mjs found")
        return 2
    if dry:
        print("DRY_RUN: nothing touched")
        return 0
    DIR.mkdir(parents=True, exist_ok=True)
    SWITCHING.write_text(f"{utc()} pid {os.getpid()} {old_lab} -> {label}\n")
    event("SWITCHING", f"Go account {old_lab} -> {label}: no new wave starts; waiting for every wave in flight and "
          f"every relay slot to go idle")
    t0 = time.time()
    try:
        quiet_since = None
        prev = None
        while True:
            with _Locked():
                busy = _inflight()
                meter_update()
            cs = {r["env"]["RELAY_COUNTERS_PORT"]: _counters(int(r["env"]["RELAY_COUNTERS_PORT"])) or {} for r in rs}
            reqs = {k: c.get("chat_requests") for k, c in cs.items()}
            idle = not busy and all(_unsettled(c) <= 0 for c in cs.values()) and reqs == prev
            prev = reqs
            quiet_since = (quiet_since or time.time()) if idle else None
            if quiet_since and time.time() - quiet_since >= 60:
                break
            if time.time() - t0 > wait_max_s:
                raise RuntimeError(f"not idle after {wait_max_s:.0f} s (waves in flight: "
                                   f"{[b['study'] + ' ' + b['wave'] for b in busy]})")
            time.sleep(15)
        with _Locked():
            m = meter_update()
            h = headroom(m)
        (DIR / f"meter-{old_lab}-{utc().replace(':', '')}.json").write_text(json.dumps(m, indent=1) + "\n")
        started, rec = [], {"t": utc(), "from": old_lab, "to": label, "plan": plan, "auth_file": auth_file,
                            "old_headroom": h, "relays": []}
        try:
            for r in rs:
                port = int(r["env"]["RELAY_COUNTERS_PORT"])
                _stop(r["pid"])
                pid = _start(r, auth_file, f"go account switch {old_lab} -> {label} (go_allowance.py)")
                for _ in range(50):
                    if _listening(port):
                        break
                    time.sleep(0.2)
                else:
                    raise RuntimeError(f"relay on counters {port} did not start on the new auth file "
                                       f"(no opencode-go key in it? see {r['log']})")
                started.append((r, pid))
        except Exception:
            for r, pid in started:  # roll every relay back onto the auth file it had
                _stop(pid)
                _start(r, r["env"]["RELAY_AUTH_FILE"], "switch rolled back")
            if r not in [x for x, _ in started]:
                _start(r, r["env"]["RELAY_AUTH_FILE"], "switch rolled back")
            raise
        expect = "go-plus" if plan == "go-plus" else "go"
        ok = True
        for r, pid in started:
            pr = probe(r, label)
            good = pr.get("status") == 200 and pr.get("billing_source") == expect and not pr.get("cost")
            ok &= good
            rec["relays"].append({"old_pid": r["pid"], "pid": pid, "bind": r["env"].get("RELAY_BIND"),
                                  "port": r["env"].get("RELAY_PORT"),
                                  "counters_port": r["env"].get("RELAY_COUNTERS_PORT"), "probe": pr, "ok": good})
            print(f"  probe :{r['env'].get('RELAY_PORT')} -> {pr}")
        ratios = [x["probe"].get("allowance_per_list") for x in rec["relays"] if x["probe"].get("allowance_per_list")]
        with _Locked():
            a = accounts()
            prev_acct = (a.get("accounts") or {}).get(label, {})
            lim = LIMITS[plan]
            base = prev_acct.get("baseline") if prev_acct.get("auth_file") == auth_file and weekly is None else None
            a.setdefault("accounts", {})[label] = {
                "auth_file": auth_file, "plan": plan, "billing_label": expect,
                "allowance_per_list": round(sum(ratios) / len(ratios), 4) if ratios else None,
                "probe_ok": ok, "switched_in": rec["t"],
                "baseline": base or {"t": utc(), "t_epoch": round(time.time()),
                                     "weekly_remaining_usd": weekly if weekly is not None else lim["weekly"],
                                     "monthly_remaining_usd": None, "spent_5h_usd_at_baseline": 0.0,
                                     "note": "operator-stated" if weekly is not None else
                                     f"ASSUMED full weekly {plan} limit (${lim['weekly']}); correct with set-baseline"}}
            a["current"] = label
            _save(ACCOUNTS, a)
            meter_update()  # starts the new account's meter (first sight = 0)
        rec["ok"] = ok
        with open(SWITCHES, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        event("SWITCH", f"Go account {old_lab} -> {label} ({plan}): {len(started)} relays restarted on "
              f"{auth_file}; probes {'all 200 billed ' + expect if ok else 'FAILED — runners stay paused'}; "
              f"allowance/list {ratios[:1] or 'n/a'}; switches.jsonl")
        return 0 if ok else 1
    except Exception as e:
        event("SWITCH-FAILED", f"Go account {old_lab} -> {label}: {type(e).__name__}: {e}; relays left on "
              f"{old_lab}'s auth file")
        return 1
    finally:
        SWITCHING.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "status"
    if cmd == "status":
        with _Locked():
            m = meter_update()
            print(json.dumps({"headroom": headroom(m), "flag": _load(FLAG, None), "switching": SWITCHING.exists(),
                              "inflight": _inflight(), "account": current()[0]}, indent=1))
        return 0
    if cmd == "set-baseline":  # set-baseline <label> <weekly_remaining_usd> [monthly_remaining_usd] [note...]
        lab, wk = argv[1], float(argv[2])
        mo = float(argv[3]) if len(argv) > 3 and argv[3] != "-" else None
        with _Locked():
            a = accounts()
            acct = a["accounts"][lab]
            acct["baseline"] = {"t": utc(), "t_epoch": round(time.time()), "weekly_remaining_usd": wk,
                                "monthly_remaining_usd": mo, "note": " ".join(argv[4:]) or "operator, from the Console"}
            _save(ACCOUNTS, a)
            if a.get("current") == lab:
                m = _load(METER, {})
                m.update({"account": lab, "since": utc(), "spent_usd": 0.0})
                _save(METER, m)
        event("BASELINE", f"{lab}: weekly remaining ${wk} (monthly {mo}) from the operator; meter reset to 0")
        return 0
    if cmd == "switch":  # switch <auth-file> <label> <plan> [weekly_remaining_usd|-]
        wk = float(argv[4]) if len(argv) > 4 and argv[4] != "-" else None
        only = {int(x) for x in os.environ.get("ONLY_COUNTER_PORTS", "").split(",") if x.strip()} or None
        return switch(argv[1], argv[2], argv[3], wk, float(os.environ.get("WAIT_MAX_S", 6 * 3600)),
                      os.environ.get("DRY_RUN") == "1", only)
    if cmd == "clear-flag":  # only for a false alarm, after checking the Console
        with _Locked():
            FLAG.unlink(missing_ok=True)
        event("FLAG-CLEARED", " ".join(argv[1:]) or "operator")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
