def delays(attempts: int, base_ms: int, cap_ms: int) -> list:
    if attempts < 0:
        raise ValueError("attempts must not be negative")
    if base_ms <= 0 or cap_ms <= 0:
        raise ValueError("base_ms and cap_ms must be positive")
    out = []
    d = base_ms
    for _ in range(attempts):
        out.append(min(d, cap_ms))
        d *= 2
    return out
