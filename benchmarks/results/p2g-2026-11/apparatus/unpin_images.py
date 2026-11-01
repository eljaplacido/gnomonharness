"""Remove the prebuilt-image pins from P2G's copy of TB 4.0, so both environments build here.

Every TB 4.0 task pins `docker_image` (amd64 only) under [environment] and
[verifier.environment]. Harbor 0.25.0 builds the agent environment from its
Dockerfile under --force-build, but starts the separate verifier environment with
force_build=False (harbor/trial/trial.py, `env.start(force_build=False)`), so it
pulls the amd64 verifier image, which cannot run on the gx10. With no pin,
Harbor builds both from the task's own environment/Dockerfile and tests/Dockerfile.

Only `docker_image = ...` lines are removed; nothing else in a task changes. The
script prints the dataset fingerprint before and after, and refuses a task whose
Dockerfile is missing, since such a task would have nothing to build from.

    python unpin_images.py <dataset dir>
"""
import hashlib
import re
import sys
from pathlib import Path


def fingerprint(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(x for x in root.rglob("*") if x.is_file()):
        h.update(p.relative_to(root).as_posix().encode() + b"\0" + p.read_bytes())
    return h.hexdigest()[:16]


def main() -> None:
    root = Path(sys.argv[1])
    print(f"before {fingerprint(root)}")
    changed = 0
    for toml in sorted(root.glob("*/task.toml")):
        task = toml.parent
        text = toml.read_text()
        needs = [task / "environment" / "Dockerfile"]
        if 'environment_mode = "separate"' in text:
            needs.append(task / "tests" / "Dockerfile")
        missing = [str(n.relative_to(task)) for n in needs if not n.exists()]
        if missing:
            print(f"left pinned: {task.name} (missing {', '.join(missing)})")
            continue
        new = re.sub(r'(?m)^docker_image = .*\n', "", text)
        if new != text:
            toml.write_text(new)
            changed += 1
    print(f"unpinned {changed} tasks")
    print(f"after  {fingerprint(root)}")


if __name__ == "__main__":
    main()
