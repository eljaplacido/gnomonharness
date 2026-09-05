def _parse(v: str):
    parts = v.split(".")
    if len(parts) != 3:
        raise ValueError("version must have three parts")
    out = []
    for p in parts:
        if not p.isdigit():
            raise ValueError("version parts must be non-negative integers")
        out.append(int(p))
    return tuple(out)


def compare(a: str, b: str) -> int:
    pa, pb = _parse(a), _parse(b)
    if pa < pb:
        return -1
    if pa > pb:
        return 1
    return 0
