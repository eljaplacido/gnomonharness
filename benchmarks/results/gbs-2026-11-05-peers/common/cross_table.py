#!/usr/bin/env python3
"""Prints the run's cross-harness table (markdown) from the analysis files, so the README's numbers
are generated, not typed:  python3 -I common/cross_table.py"""
import json
from pathlib import Path

H = Path(__file__).resolve().parent.parent
ch = json.loads((H / "chaos/analysis.json").read_text())["runs"]
ov = json.loads((H / "overhead/analysis.json").read_text())
gv = json.loads((H / "governance/summary.json").read_text())
au = json.loads((H / "audit/summary.json").read_text())


def ci(c):
    return f" [{c['ci95'][0]:g}, {c['ci95'][1]:g}]" if c.get("ci95") else ""


def aad(x):
    return f"{x['allow']} / {x['ask']} / {x['deny']}"


def chaos(h):
    s = ch[f"{h}-seed1"]["summary"]
    return (f"{s['faults_announced']}/{s['faults']} faults; {s['cases_announced']}/{s['cases_fired']} fired cases"
            + (f" ({s['cases_unsupported']} of 37 unsupported)" if s.get("cases_unsupported") else "")
            + f"; silent failures {s['silent_failures']}/{s['failed']}")


cell = ov["cells"]["S1/d0"]; pr = ov["paired"]["S1/d0"]
OC, OB, GD, GG = gv["opencode-default"], gv["opencode-best"], gv["gnomon-D"], gv["gnomon-G"]
rows = [
    ("CHAOS", "announced (seed 1, black-box via `chaos serve`; one configuration per harness)", chaos("opencode") + " (shipped defaults + provider)", "—", chaos("gnomon") + " (the reference surface)", "—"),
    ("OVERHEAD", "S1 CPU per trial, median (d = 0)", f"{cell['opencode']['cpu_ms']['median']:,.0f} ms", f"best-effort fast (`snapshot: false`): {cell['opencode-fast']['cpu_ms']['median']:,.0f} ms",
     f"{cell['gnomon']['cpu_ms']['median']:,.0f} ms", f"best-effort fast n/a; governance-off: {cell['gnomon-gov-off']['cpu_ms']['median']:,.0f} ms"),
    ("OVERHEAD", "over its own runtime's null harness, paired [95% CI]", f"+{pr['opencode - N-bun']['cpu_ms_median']:,.0f} [{pr['opencode - N-bun']['cpu_ms_ci95'][0]:,.0f}, {pr['opencode - N-bun']['cpu_ms_ci95'][1]:,.0f}] (Bun)",
     f"+{pr['opencode-fast - N-bun']['cpu_ms_median']:,.0f}", f"+{pr['gnomon - N']['cpu_ms_median']:,.0f} [{pr['gnomon - N']['cpu_ms_ci95'][0]:,.0f}, {pr['gnomon - N']['cpu_ms_ci95'][1]:,.0f}] (Node)",
     f"+{pr['gnomon-gov-off - N']['cpu_ms_median']:,.0f}"),
]
for scope, label in (("in-root", "G-2 in-root respellings"), ("out-of-root", "G-2 out-of-root"), ("egress", "G-2 egress"), ("history", "G-2 force-push / history")):
    rows.append(("GOVERNANCE", f"{label}: allow / ask / deny (n)", *(f"{aad(R['G-2'][scope])} ({R['G-2'][scope]['n']})" for R in (OC, OB, GD, GG))))
rows.append(("GOVERNANCE", "G-2 everyday commands: allow / ask / deny (n)", *(f"{aad(R['G-2']['everyday'])} ({R['G-2']['everyday']['n']})" for R in (OC, OB, GD, GG))))
rows.append(("GOVERNANCE", "G-4 injected attacks: allow / ask / deny (two-pass, readme carrier)", *(f"{aad(R['G-4']['two_pass_readme']['all'])} ({R['G-4']['two_pass_readme']['all']['n']})" for R in (OC, OB, GD, GG))))
rows.append(("GOVERNANCE", "G-4 P(block given attempt), asks auto-approved, 5 carriers", *(f"{R['G-4']['P_block_given_attempt_auto']['k']}/{R['G-4']['P_block_given_attempt_auto']['n']}{ci(R['G-4']['P_block_given_attempt_auto'])}" for R in (OC, OB, GD, GG))))
def g3(R):
    def one(p):
        x = R["G-3"][p]; u = len(x["unattempted"])
        return f"{x['k']}/{x['n']}" + (f" ({u} not attempted)" if u else "")
    return f"auto {one('auto')}; headless {one('headless')}"
rows.append(("GOVERNANCE", "G-3 self-governance probes passed", *(g3(R) for R in (OC, OB, GD, GG))))
lv = lambda r: " · ".join(f"{L} {x['detected']}/{x['run']}" for L, x in r["levels"].items())
rows.append(("AUDIT", "tamper cases detected by the documented verifier, per adversary level (N/A cases excluded)", f"{lv(au['opencode'])}: no verifier documented", "—", f"`[audit]` default: {lv(au['gnomon-off'])}", f"git anchor: {lv(au['gnomon-git'])}"))
print("| Spec | Measure | opencode v2.2.5 default | opencode v2.2.5 best-effort | gnomon v0.4.2 default | gnomon v0.4.2 best-effort |")
print("|---|---|---|---|---|---|")
for r in rows:
    print("| " + " | ".join(r) + " |")
