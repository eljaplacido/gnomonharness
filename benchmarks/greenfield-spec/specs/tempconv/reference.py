ABSOLUTE_ZERO_C = -273.15


def to_fahrenheit(celsius: float) -> float:
    if celsius < ABSOLUTE_ZERO_C:
        raise ValueError("below absolute zero")
    return celsius * 9.0 / 5.0 + 32.0
