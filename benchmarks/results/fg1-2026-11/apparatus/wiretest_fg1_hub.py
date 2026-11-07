"""FG1 Amendment 3: the wire test ON THE HUB, before any hub cell. Run from the gx10:

    python3 wiretest_fg1_hub.py [--skip-offline]      -> ../wiretest-fg1-hub.txt (its sha256 -> build.toml wiretest_hub)

A. OFFLINE, amd64: wiretest_fg1.py itself (C, FG, SH, the NEGATIVE CONTROL without the trust grant, the read-only cwd),
   unchanged but for --fake-host, inside a linux/amd64 python:3.12-bookworm container on the hub's Docker Desktop, as a
   non-root user (so the read-only cwd really is read-only), with node v22.22.2 (the gx10's), harbor 0.25.0 under the
   gx10 venv's freeze, and the pinned build installed from the hub's hash-checked copy (C:\\dev\\fg1-hub\\build).
   Its full output is embedded below; it must end in PASS.
B. LIVE PATH, per hub slot 6-8: the exact path of a hub cell's requests — a container on the hub -> the gx10's
   log-relay.mjs on 100.86.231.23:4740+slot -> relay-go.mjs on 100.86.231.23:4710+slot (key injected there) -> Go:
   one tiny streamed request with the placeholder key; HTTP 200 with usage, the log relay classes the key
   `placeholder`, the slot relay meters exactly one request with usage and no 4xx/5xx/error, go-plus at 1.2.
   Plus a NEGATIVE CONTROL of the classifier on this path: the same request with no Authorization header is classed
   `absent` by the log relay (and is not counted as the placeholder).
C. MIRROR: from a hub container, SHA256SUMS from http://100.86.231.23:4759 hashes to build.toml's sums_sha256 and
   every tarball matches it (the cells re-check this three ways anyway).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
import tomllib
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path[:0] = [str(HERE)]
import hub_lane as H  # noqa: E402

P2G_APP = ROOT.parent / "p2g-2026-11" / "apparatus"
PLACEHOLDER = "p2g-relay-placeholder"
GO_RATIO = 1.2
IMAGE = "python:3.12-bookworm"
NODE = "v22.22.2"
LINES: list[str] = []
ok_all = True


def say(s: str) -> None:
    LINES.append(s)
    print(s, flush=True)


def check(cond, what: str) -> None:
    global ok_all
    say(f"  {'ok  ' if cond else 'FAIL'} {what}")
    ok_all = ok_all and bool(cond)


DOCKER = f"set DOCKER_CONFIG={H.HUB_ROOT}\\docker-config& docker"

OFFLINE_SH = f"""set -e
apt-get -qq update >/dev/null && apt-get -qq install -y xz-utils >/dev/null
curl -fsSL https://nodejs.org/dist/{NODE}/node-{NODE}-linux-x64.tar.xz | tar -xJ -C /opt
export PATH=/opt/node-{NODE}-linux-x64/bin:$PATH
pip install -q --root-user-action=ignore -c /hub/constraints-gx10.txt harbor==0.25.0 >/dev/null
mkdir -p /opt/g && npm i -g --silent --prefix /opt/g /hub/build/v0.4.5/gnomon-core-0.4.5.tgz \
  /hub/build/v0.4.5/gnomon-natives-0.4.5.tgz /hub/build/v0.4.5/gnomon-tui-0.4.5.tgz /hub/build/v0.4.5/gnomon-harness-0.4.5.tgz
useradd -m wt
cp -r /hub/wt/app /home/wt/app && chown -R wt /home/wt/app
IP=$(hostname -I | awk '{{print $1}}')
echo "env: $(uname -m) node $(node --version) $(python3 --version) harbor $(harbor --version) fake-host $IP user wt"
su wt -c "export PATH=/opt/node-{NODE}-linux-x64/bin:/opt/g/bin:/usr/local/bin:/usr/bin:/bin; cd /home/wt/app && \
  python3 wiretest_fg1.py /opt/g /tmp/wtwork --fake-host $IP --out /tmp/wiretest-offline.txt; echo \\$? > /tmp/rc"
cp /tmp/wiretest-offline.txt /hub/wt/out/wiretest-offline.txt
exit $(cat /tmp/rc)
"""

LIVE_PY = r"""
import json, sys, urllib.request
port, s, auth = sys.argv[1], sys.argv[2], sys.argv[3]
body = {"model": "deepseek-v4.1-flash", "stream": True, "stream_options": {"include_usage": True}, "temperature": 0,
        "max_tokens": 16, "messages": [{"role": "user", "content": "Reply with exactly the word: ok"}]}
h = {"content-type": "application/json", "user-agent": "gnomon-fg1-wiretest-hub/1", "x-opencode-session": "fg1-wt-hub-" + s}
if auth == "yes":
    h["authorization"] = "Bearer p2g-relay-placeholder"
req = urllib.request.Request("http://100.86.231.23:%s/openai/v1/chat/completions" % port, method="POST",
                             data=json.dumps(body).encode(), headers=h)
status, usage = None, None
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        status, text = r.status, r.read().decode(errors="replace")
    for line in text.splitlines():
        if line.startswith("data:") and line.strip() != "data: [DONE]":
            try:
                o = json.loads(line[5:])
            except Exception:
                continue
            usage = o.get("usage") or usage
except urllib.error.HTTPError as e:
    status = e.code
print("RESULT " + json.dumps({"status": status, "usage": usage}))
"""

MIRROR_PY = r"""
import hashlib, json, sys, urllib.request
b = "http://100.86.231.23:%s/v0.4.5/" % sys.argv[1]
sums = urllib.request.urlopen(b + "SHA256SUMS", timeout=60).read()
out = {"sums": hashlib.sha256(sums).hexdigest(), "files": {}}
for l in sums.decode().splitlines():
    if l.strip():
        h, n = l.split()
        out["files"][n] = hashlib.sha256(urllib.request.urlopen(b + n, timeout=300).read()).hexdigest() == h
print("RESULT " + json.dumps(out))
"""


def hub_python(code: str, args: list[str]) -> dict:
    """Run a short python script in a fresh amd64 container on the hub; returns its RESULT json."""
    f = ROOT / "wt-hub-snippet.py"
    f.write_text(code, encoding="utf-8")
    H.scp_to(f, "wt\\snippet.py")
    f.unlink()
    r = H.ssh(f"{DOCKER} run --rm --platform linux/amd64 -v {H.HUB_ROOT}\\wt:/w {IMAGE} python3 /w/snippet.py "
              + " ".join(args), timeout=600)
    line = [l for l in r.stdout.splitlines() if l.startswith("RESULT ")]
    if not line:
        raise RuntimeError(f"hub container gave no RESULT: rc {r.returncode} {r.stdout[-300:]} {r.stderr[-300:]}")
    return json.loads(line[-1][7:])


def ctr(s: int) -> dict:
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{4810 + s}/counters", timeout=10))


def offline(b: dict) -> None:
    say("== A. offline wire test (wiretest_fg1.py) in a linux/amd64 container on the hub")
    H.ssh_retry(f"rmdir /s /q {H.HUB_ROOT}\\wt 2>nul & mkdir {H.HUB_ROOT}\\wt\\app\\arms {H.HUB_ROOT}\\wt\\out & echo ok")
    for f in ("wiretest_fg1.py", "fg1_checks.py", "surface_patch.py", "build.toml", "log-relay.mjs"):
        H.scp_to(HERE / f, f"wt\\app\\{f}")
    H.scp_to(P2G_APP / "gnomon_harbor.py", "wt\\app\\gnomon_harbor.py")
    for f in sorted((HERE / "arms").glob("*.toml")):
        H.scp_to(f, f"wt\\app\\arms\\{f.name}")
    sh = ROOT / "wt-hub-offline.sh"
    sh.write_text(OFFLINE_SH, encoding="utf-8", newline="\n")
    H.scp_to(sh, "wt\\offline.sh")
    sh.unlink()
    cmd = (f"cmd /c {DOCKER} run --rm --platform linux/amd64 -v {H.HUB_ROOT}:/hub {IMAGE} bash /hub/wt/offline.sh "
           f"> {H.HUB_ROOT}\\wt\\out\\docker.log 2>&1 & echo %ERRORLEVEL% > {H.HUB_ROOT}\\wt\\out\\rc.txt")
    cmdf = ROOT / "wt-hub-offline.cmd"
    cmdf.write_text("@echo off\r\n" + cmd[len("cmd /c "):] + "\r\n", encoding="utf-8", newline="")
    H.scp_to(cmdf, "wt\\offline.cmd")
    cmdf.unlink()
    pid = H.start_detached(f"cmd /c {H.HUB_ROOT}\\wt\\offline.cmd")
    say(f"  started detached on the hub (pid {pid}); image {IMAGE} linux/amd64")
    t0 = time.time()
    while time.time() - t0 < 3600:
        time.sleep(20)
        r = H.ssh(f"if exist {H.HUB_ROOT}\\wt\\out\\rc.txt type {H.HUB_ROOT}\\wt\\out\\rc.txt", timeout=60)
        if r.stdout.strip():
            break
    rc = H.ssh(f"type {H.HUB_ROOT}\\wt\\out\\rc.txt", timeout=60).stdout.strip()
    log = H.ssh(f"type {H.HUB_ROOT}\\wt\\out\\docker.log", timeout=60).stdout
    out = H.ssh(f"type {H.HUB_ROOT}\\wt\\out\\wiretest-offline.txt", timeout=60).stdout
    envl = [l for l in log.splitlines() if l.startswith("env: ")]
    say(f"  container exit {rc}; {envl[-1] if envl else 'no env line'} ({time.time() - t0:.0f} s)")
    say("  ---- wiretest_fg1.py output (amd64, hub) ----")
    for l in out.replace("\r", "").splitlines():
        say("  | " + l)
    say("  ---- end ----")
    last = [l for l in out.replace("\r", "").splitlines() if l.startswith("wire test: ")]
    check(rc == "0" and last and last[-1].startswith("wire test: PASS ("),
          "offline wire test on amd64: PASS (C, FG, SH, negative control, read-only cwd)")
    neg = [l for l in out.splitlines() if "negative control:" in l]
    check(neg and neg[-1].strip().startswith("ok"), "negative control (no trust grant -> key check FAILS) fired")


def live(slots: list[int]) -> None:
    say(f"\n== B. live path from a hub container through the gx10's Tailscale relays, slots {slots}")
    for s in slots:
        port, up = 4740 + s, 4710 + s
        for auth in ("yes", "no"):
            wire = ROOT / f"wt-hub-live-slot{s}-{auth}"
            relay = subprocess.Popen(["node", str(HERE / "log-relay.mjs"), f"{H.TS_IP}:{port}", f"http://{H.TS_IP}:{up}",
                                      str(wire)], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                                     env={"PATH": "/usr/bin:/bin:/usr/local/bin", "FG1_KEY_PLACEHOLDER": PLACEHOLDER})
            time.sleep(1.5)
            try:
                before = ctr(s)
                res = hub_python(LIVE_PY, [str(port), str(s), auth])
                time.sleep(1)
                after = ctr(s)
            finally:
                relay.terminate()
                relay.wait(timeout=10)
            rows = [json.loads(l) for l in (wire / "calls.jsonl").read_text().splitlines() if l.strip()] \
                if (wire / "calls.jsonl").exists() else []
            subprocess.run(["rm", "-rf", str(wire)])
            d = {k: round(after[k] - before[k], 10) for k in ("chat_requests", "responses_with_usage", "status_4xx",
                                                              "status_5xx", "errors", "allowance")}
            usage = res.get("usage") or {}
            oc = usage.get("opencode") or {}
            ratio = round(oc["allowance"] / oc["list_cost"], 3) if oc.get("list_cost") else None
            say(f"slot {s} auth={auth}: HTTP {res.get('status')}, usage in {usage.get('prompt_tokens')} out "
                f"{usage.get('completion_tokens')}, billing {oc.get('billing_source')}, ratio {ratio}; log-relay auth "
                f"{[r.get('auth') for r in rows]}; counters delta {d}")
            if auth == "yes":
                check(res.get("status") == 200 and res.get("usage"), f"slot {s}: HTTP 200 with usage from the hub")
                check([r.get("auth") for r in rows] == ["placeholder"], f"slot {s}: log relay saw the placeholder key")
                check(d["chat_requests"] == 1 and d["responses_with_usage"] == 1 and not (d["status_4xx"] or
                      d["status_5xx"] or d["errors"]), f"slot {s}: slot relay metered one request with usage, no errors")
                check(oc.get("billing_source") == "go-plus" and ratio == GO_RATIO,
                      f"slot {s}: billed go-plus at allowance/list {GO_RATIO}")
            else:
                check([r.get("auth") for r in rows] == ["absent"],
                      f"slot {s}: NEGATIVE CONTROL — no Authorization header is classed 'absent' (the key check can fail)")


def mirror(b: dict) -> None:
    say(f"\n== C. mirror {H.TS_IP}:{H.MIRROR_PORT} from a hub container")
    m = subprocess.Popen([sys.executable, "-m", "http.server", str(H.MIRROR_PORT), "--bind", H.TS_IP, "--directory",
                          str(HERE / "build")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        res = hub_python(MIRROR_PY, [str(H.MIRROR_PORT)])
    finally:
        m.terminate()
        m.wait(timeout=10)
    say(f"  SHA256SUMS {res['sums']}; tarballs {res['files']}")
    check(res["sums"] == b["sums_sha256"] and len(res["files"]) == 4 and all(res["files"].values()),
          "mirror from the hub: SHA256SUMS = build.toml sums_sha256 and all four tarballs match")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "wiretest-fg1-hub.txt"))
    ap.add_argument("--slots", default="6,7,8")
    a = ap.parse_args()
    b = tomllib.loads((HERE / "build.toml").read_text())["build"]
    say(f"== FG1 hub wire test (Amendment 3) {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}; build "
        f"{b['version']} {b['commit'][:12]} {b['build_stamp']}; hub {H.HUB_SSH} {H.HUB_ROOT}")
    hv = H.ssh(f"{H.HUB_ROOT}\\.venv\\Scripts\\harbor.exe --version & {H.HUB_ROOT}\\.venv\\Scripts\\python.exe "
               f"--version & {DOCKER} version --format {{{{.Server.Os}}}}/{{{{.Server.Arch}}}}/{{{{.Server.Version}}}}",
               timeout=120).stdout.split()
    say(f"hub: harbor {hv[0] if hv else '?'}, {' '.join(hv[1:3])}, docker {hv[-1] if hv else '?'}")
    check(hv and hv[0] == "0.25.0" and "linux/amd64" in hv[-1], "hub harbor 0.25.0 on a linux/amd64 docker engine")
    offline(b)
    live([int(x) for x in a.slots.split(",")])
    mirror(b)
    say(f"\nwire test: {'PASS' if ok_all else 'FAIL'} (hub, gnomon {b['build_stamp']}, amd64 offline + live slots "
        f"{a.slots} + mirror)")
    Path(a.out).write_text("\n".join(LINES) + "\n", encoding="utf-8")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
