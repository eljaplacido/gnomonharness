set -u
export HOME=/root/h GNOMON_NO_UPDATE_CHECK=1; mkdir -p $HOME
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git curl ca-certificates python3 >/dev/null 2>&1
git config --global user.email a@b.c; git config --global user.name audit; git config --global init.defaultBranch main
curl -fsSL https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh | GNOMON_VERSION=0.3.3 sh >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
mkdir -p /p && cd /p && git init -q && mkdir src tests && printf 'def add(a, b):\n    return a - b\n' > src/lib.py && git add -A && git commit -qm base && gnomon init >/dev/null 2>&1 && git add -A && git commit -qm surface
printf 'def add(a, b):\n    return a + b\n' > src/lib.py && git add -A && git commit -qm fix
echo "== check src change"; gnomon check --base HEAD~1 --head HEAD --role implement --json | python3 -c 'import json,sys;j=json.load(sys.stdin);print("verdict",j.get("verdict"),"exit",j.get("exit"));[print(" ",c.get("check"),c.get("status"),str(c.get("reason") or c.get("detail") or "")[:120]) for c in j.get("checks",[])]'; echo rc=${PIPESTATUS[0]}
echo x > .gnomon/evil.txt; echo "hack" >> README.md 2>/dev/null; git add -A && git commit -qm bad
echo "== check .gnomon change"; gnomon check --base HEAD~1 --head HEAD --role implement --json >/dev/null; echo rc=$?
echo "== guard force push"; gnomon guard --role implement --tool bash --input '{"command":"git push --force origin main"}'; echo rc=$?
echo "== guard ls"; gnomon guard --role implement --tool bash --input '{"command":"ls -la"}'; echo rc=$?
