"""Compare food and kitchen basic names the way the database does."""

from __future__ import annotations


def food_name_key(name: str) -> str:
    """Return the identity of a food or kitchen basic name.

    Mirrors ``public.food_name_key`` in the foods migration: ``lower()``,
    with surrounding whitespace trimmed and inner runs collapsed to one
    space, so " salt " and "Salt" are the same name. Uses ``lower()``, not
    ``casefold()``, because Postgres ``lower()`` leaves "ß" unchanged and
    ``casefold()`` turns it into "ss".
    """
    return " ".join(name.lower().split())
