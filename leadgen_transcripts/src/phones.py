"""Phone-number normalisation and matching.

Kommo stores phones however the manager typed them ("+38 (067) 123-45-67",
"0671234567", "38067...").  Ringostat returns its own format.  To join the two
data sets we reduce every number to a canonical key.

The join key is the last ``MATCH_DIGITS`` digits of the number.  For Ukraine
that is the operator code + subscriber number, which is unique and survives
every prefix variation (``+380``/``380``/``80``/``0``).
"""

from __future__ import annotations

import re

MATCH_DIGITS = 9

_NON_DIGIT = re.compile(r"\D+")


def digits(raw: str | None) -> str:
    """Strip everything that is not a digit."""
    if not raw:
        return ""
    return _NON_DIGIT.sub("", str(raw))


def to_e164_ua(raw: str | None) -> str:
    """Best-effort E.164 rendering, assuming Ukrainian numbers by default.

    Non-Ukrainian numbers are passed through with a leading ``+`` once they
    look long enough to be international.
    """
    d = digits(raw)
    if not d:
        return ""
    if d.startswith("00"):
        d = d[2:]
    if len(d) == 9:                       # 671234567
        return "+380" + d
    if len(d) == 10 and d.startswith("0"):  # 0671234567
        return "+38" + d
    if len(d) == 11 and d.startswith("80"):  # 80671234567
        return "+3" + d
    if len(d) == 12 and d.startswith("380"):  # 380671234567
        return "+" + d
    if len(d) >= 10:
        return "+" + d
    return d


def match_key(raw: str | None) -> str:
    """Canonical join key: the trailing :data:`MATCH_DIGITS` digits.

    Returns an empty string for anything too short to be a real number, so
    callers can skip it rather than joining on noise.
    """
    d = digits(raw)
    if len(d) < MATCH_DIGITS:
        return ""
    return d[-MATCH_DIGITS:]


def is_internal(raw: str | None) -> bool:
    """True for short internal extensions (e.g. "101"), which are not clients."""
    return 0 < len(digits(raw)) < MATCH_DIGITS
