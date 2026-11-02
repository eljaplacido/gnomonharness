#!/bin/bash
# Run by run_peers.sh before it takes the GPU lock. Each arm's setup and the gnomon
# run script it writes are checked through bash itself, never by extracting the text
# another way. The smoke run of 2026-10-31 lost its gnomon cell to an apostrophe
# ("scaffold's") inside `node -e '...'`: the patch had been checked by extracting it
# with a regex and running node on the file, which never sees bash's quoting.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

for f in mini-setup-peers.sh goose-setup-peers.sh qwen-setup-peers.sh opencode-setup-peers.sh gnomon-setup-peers.sh.j2; do
  bash -n "$HERE/$f" || { echo "preflight: $f does not parse"; exit 1; }
  grep -q '^echo "ARM_SETUP_END=' "$HERE/$f" || { echo "preflight: $f prints no ARM_SETUP_END"; exit 1; }
done

# The run script, written by the setup's own heredoc, to a file here instead of /opt.
python3 -I - "$HERE/gnomon-setup-peers.sh.j2" "$T" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r"cat > /opt/gnomon-run.sh <<'RUN'\n.*?\nRUN\n", s, re.S)
assert m, "no run-script heredoc in the gnomon setup"
assert not re.search(r"\{\{|\{%", m.group(0)), "jinja tags inside the run script"
open(f"{sys.argv[2]}/write.sh", "w").write(m.group(0).replace("/opt/gnomon-run.sh", f"{sys.argv[2]}/gnomon-run.sh"))
PY
bash "$T/write.sh"
bash -n "$T/gnomon-run.sh" || { echo "preflight: the gnomon run script does not parse"; exit 1; }

# Every `node -e '...'` in it, unquoted by bash and handed to node --check.
python3 -I - "$T" <<'PY'
import re, sys
T = sys.argv[1]
s = open(f"{T}/gnomon-run.sh").read()
blocks = re.findall(r"^node -e '.*?'\n", s, re.S | re.M)
assert blocks, "no node -e block found"
for i, b in enumerate(blocks):
    open(f"{T}/node{i}.sh", "w").write("printf '%s' " + b[len("node -e "):])
print(len(blocks))
PY
for f in "$T"/node*.sh; do
  bash "$f" > "$f.js"
  node --check "$f.js" || { echo "preflight: a node -e block is not valid JS as bash passes it"; exit 1; }
done
echo "preflight: setups parse; the gnomon run script and its node blocks survive bash"
