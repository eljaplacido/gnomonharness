Write `csvfield.py` providing a splitter for one CSV line.

Public API, exactly:
    split_line(line: str) -> list[str]

Fields are comma-separated. A field may be wrapped in double quotes, and inside
quotes a comma is part of the field. A doubled quote inside a quoted field means
one literal quote.

Also write `test_csvfield.py` with unit tests for it.
