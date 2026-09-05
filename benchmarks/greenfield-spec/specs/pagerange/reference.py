def parse(spec: str) -> list:
    if not spec.strip():
        raise ValueError("empty spec")
    out = []
    for item in spec.split(","):
        item = item.strip()
        if not item:
            raise ValueError("empty item")
        if "-" in item:
            lo_s, _, hi_s = item.partition("-")
            if not lo_s.isdigit() or not hi_s.isdigit():
                raise ValueError("malformed range")
            lo, hi = int(lo_s), int(hi_s)
            if hi < lo:
                raise ValueError("range runs backwards")
            out.extend(range(lo, hi + 1))
        else:
            if not item.isdigit():
                raise ValueError("malformed page")
            out.append(int(item))
    return out
