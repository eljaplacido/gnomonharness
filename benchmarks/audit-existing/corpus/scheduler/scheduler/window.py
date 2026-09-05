"""Time windows. See SPEC.md, "Windows"."""


class Window:
    """A half-open hour interval [start_hour, end_hour).

    A job may run at start_hour and may NOT run at end_hour.
    Raises ValueError when end_hour is not after start_hour.
    """

    def __init__(self, start_hour: int, end_hour: int):
        if start_hour < 0 or start_hour > 23:
            raise ValueError("start_hour out of range")
        self.start_hour = start_hour
        self.end_hour = end_hour

    def contains(self, hour: int) -> bool:
        """True when `hour` falls inside the half-open window."""
        return self.start_hour <= hour <= self.end_hour

    def length(self) -> int:
        """Hours covered by the window."""
        return self.end_hour - self.start_hour
