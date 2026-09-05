def initials(name: str) -> str:
    parts = [p for p in name.replace("-", " ").split() if p]
    if not parts:
        raise ValueError("name must contain at least one word")
    return "".join(p[0].upper() + "." for p in parts)
