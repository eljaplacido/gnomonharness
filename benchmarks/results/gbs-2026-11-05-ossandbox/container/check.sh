#!/bin/sh
# Runs inside a --network none container. Every target is under /tmp in the container.
X=/opt/osb/gnomon-exec
echo "== id: $(id -u):$(id -g)  kernel: $(uname -r)"
echo "== seccomp mode: $(grep -E '^(Seccomp|NoNewPrivs)' /proc/self/status | tr '\n' ' ')"
echo "== probe"; $X sandbox-probe | grep -E '"(supported|network_supported|mechanism|landlock_abi|reason|reads_scoped_supported)"'
mkdir -p /tmp/r /tmp/t /tmp/o /tmp/h/.ssh; echo keep > /tmp/o/keep; echo FAKE-KEY-container-test > /tmp/h/.ssh/id_x
echo "== fs: write outside root, network on"
$X sandbox --root /tmp/r --write /tmp/t --network on -- /bin/sh -c 'echo x > /tmp/o/esc; echo in > /tmp/r/f; rm -f /tmp/o/keep'; echo "exit=$?"
echo "   outside esc exists: $([ -e /tmp/o/esc ] && echo YES || echo no); keep intact: $([ -e /tmp/o/keep ] && echo yes || echo NO); in-root write: $(cat /tmp/r/f 2>/dev/null)"
echo "== network off: loopback server and external connect"
python3 -m http.server 18080 --bind 127.0.0.1 >/dev/null 2>&1 & SRV=$!; sleep 1
$X sandbox --root /tmp/r --write /tmp/t --network off -- /bin/sh -c 'curl -s -m 3 -o /dev/null -w "local=%{http_code}\n" http://127.0.0.1:18080/; curl -sS -m 3 http://192.0.2.1/ 2>&1 | head -2'; echo "exit=$?"
kill $SRV 2>/dev/null
echo "== reads scoped: fake key"
HOME=/tmp/h $X sandbox --root /tmp/r --write /tmp/t --network off --reads scoped -- /bin/sh -c 'cat ~/.ssh/id_x; python3 -c "import json; print(\"py ok\")"; node -e "console.log(\"node ok\")"'; echo "exit=$?"
