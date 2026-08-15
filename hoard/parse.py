"""
Parse generation metadata.

Thin wrapper around the shared sdmeta.parse() (see sdmeta.py at the repo
root for the format and parsing details) -- kept as hoard's own public entry
point since it's imported elsewhere in this package and from bin/hoard as
`hoard.parse.parse_parameters`.
"""

import sdmeta


def parse_parameters(text: str) -> dict:
    return sdmeta.parse(text)
