Write `pagerange.py` providing a parser for page-range strings.

Public API, exactly:
    parse(spec: str) -> list[int]

A spec is comma-separated items; each item is either a single page ("3") or an
inclusive range ("5-8"). Return the pages in the order given.

Also write `test_pagerange.py` with unit tests for it.
