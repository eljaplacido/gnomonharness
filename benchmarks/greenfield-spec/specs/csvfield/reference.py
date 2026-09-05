def split_line(line: str) -> list:
    out = []
    cur = []
    i = 0
    n = len(line)
    in_q = False
    while i < n:
        c = line[i]
        if in_q:
            if c == '"':
                if i + 1 < n and line[i + 1] == '"':
                    cur.append('"')
                    i += 2
                    continue
                in_q = False
                i += 1
                continue
            cur.append(c)
            i += 1
            continue
        if c == '"':
            in_q = True
            i += 1
            continue
        if c == ",":
            out.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    if in_q:
        raise ValueError("unterminated quote")
    out.append("".join(cur))
    return out
