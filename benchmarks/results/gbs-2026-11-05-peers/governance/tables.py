#!/usr/bin/env python3
"""Prints the governance README's profile and G-3 tables from summary.json (generated, not typed).
  python3 -I governance/tables.py"""
import json
from pathlib import Path

g = json.loads((Path(__file__).resolve().parent / "summary.json").read_text())
K = [("opencode-default", "opencode default"), ("opencode-best", "opencode best-effort"), ("gnomon-D", "gnomon D (default)"), ("gnomon-G", "gnomon G (best-effort)")]


def aad(x):
    return f"{x['allow']} / {x['ask']} / {x['deny']}"


def kn(c):
    return f"{c['k']}/{c['n']}" + (f" [{c['ci95'][0]:g}, {c['ci95'][1]:g}]" if c.get("ci95") else "")


rows = []
for s in ("in-root", "out-of-root", "egress", "history"):
    rows.append((f"G-2 {s}: allow / ask / deny", [aad(g[k]["G-2"][s]) + f" ({g[k]['G-2'][s]['n']})" for k, _ in K]))
rows.append(("G-2 everyday: allow / ask / deny", [aad(g[k]["G-2"]["everyday"]) for k, _ in K]))
rows.append(("G-2 everyday refused, nobody to approve (ask + deny)", [kn(g[k]["G-2"]["everyday"]["refused_headless"]) for k, _ in K]))
rows.append(("G-4 attacks, two-pass (readme carrier): allow / ask / deny", [aad(g[k]["G-4"]["two_pass_readme"]["all"]) for k, _ in K]))
rows.append(("G-4 P(block given attempt), auto-approve, 5 carriers", [kn(g[k]["G-4"]["P_block_given_attempt_auto"]) for k, _ in K]))
for s in ("surface", "record", "in-root", "out-of-root", "egress"):
    rows.append((f"— {s}", [kn(g[k]["G-4"]["by_scope_auto"][s]) if s in g[k]["G-4"]["by_scope_auto"] else "—" for k, _ in K]))
rows.append(("G-4 end-to-end attack success, auto-approve", [kn(g[k]["G-4"]["end_to_end_success_auto"]) for k, _ in K]))
rows.append(("G-4 utility under attack / clean", [f"{kn(g[k]['G-4']['utility_under_attack_auto'])} / {g[k]['G-4']['utility_clean_auto']['k']}/{g[k]['G-4']['utility_clean_auto']['n']}" for k, _ in K]))
rows.append(("G-4 benign twins refused (tool result, diagnostic)", [kn(g[k]["G-4"]["benign_false_refusals_auto"]) for k, _ in K]))
rows.append(("G-4 permitted by design (loopback curl) blocked", [kn(g[k]["G-4"]["permitted_by_design_auto"]) for k, _ in K]))


def g1(k, p):
    x = g[k]["G-1f"][p]; a = x["after_the_fact"]
    return f"{kn(x['blocked_inline'])}; after the fact " + (a if isinstance(a, str) else f"{a['k']}/{a['n']}")


rows.append(("G-1f forced violations blocked inline, auto-approve; after-the-fact detection", [g1(k, "auto") for k, _ in K]))
rows.append(("G-1f blocked inline, nobody to approve", [kn(g[k]["G-1f"]["headless"]["blocked_inline"]) for k, _ in K]))
print("| measure | " + " | ".join(n for _, n in K) + " |")
print("|---|" + "---|" * len(K))
for m, cs in rows:
    print(f"| {m} | " + " | ".join(cs) + " |")
print()
print("| | " + " | ".join(n for _, n in K) + " |")
print("|---|" + "---|" * len(K))
for p in ("auto", "headless"):
    cs = []
    for k, _ in K:
        x = g[k]["G-3"][p]
        failed = "every probe, direct and through a subagent" if x["k"] == 0 else ", ".join(f"{i} ({pa})" for i, pa in x["failed"])
        cs.append(f"{x['k']}/{x['n']} held" + (f"; failed: {failed}" if x["failed"] else "")
                  + (f"; {len(x['unattempted'])} not attempted (the delegation itself was refused)" if x["unattempted"] else ""))
    print(f"| {'asks auto-approved' if p == 'auto' else 'nobody to approve'} | " + " | ".join(cs) + " |")
