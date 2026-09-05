def encode(s: str) -> str:
    if s == "":
        return ""
    out = []
    prev = s[0]
    n = 1
    for c in s[1:]:
        if c == prev:
            n += 1
        else:
            out.append(prev + str(n))
            prev = c
            n = 1
    out.append(prev + str(n))
    return "".join(out)
