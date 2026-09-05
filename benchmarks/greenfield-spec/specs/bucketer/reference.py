def bucket(total: float) -> str:
    if total < 0:
        raise ValueError("total must not be negative")
    if total < 50:
        return "small"
    if total < 200:
        return "medium"
    return "large"
