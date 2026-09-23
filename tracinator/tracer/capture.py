from __future__ import annotations

import inspect

# Types where `id()` equality can never mean "the same mutation is visible
# elsewhere" — either they're interned/cached by CPython (small ints, some
# string literals) or they're structurally incapable of in-place mutation.
# Excluding them from identity tracking avoids false-positive alias links.
# See phase3.3-variable-panel-refactor.md, section 4 / "Mutable-type identity capture".
IMMUTABLE_TYPES = (int, float, str, bytes, bool, type(None), tuple, frozenset)

# How deep to recurse into nested objects/containers, and how many
# items/attributes to show per level, before falling back to a truncation
# marker. Bounds both the payload size and the time spent walking arbitrarily
# large/deep real-world data (long lists, wide objects, deep trees).
MAX_DEPTH = 4
MAX_ITEMS = 50
MAX_REPR_LEN = 2000

_CONTAINER_TYPES = (list, tuple, set, frozenset)


def _safe_repr(value: object, limit: int = MAX_REPR_LEN) -> str:
    try:
        s = repr(value)
    except Exception as e:
        return f"<unrepr-able: {e!r}>"
    if len(s) > limit:
        return s[:limit] + f"… (+{len(s) - limit} chars)"
    return s


def _obj_id(value: object) -> int | None:
    return None if isinstance(value, IMMUTABLE_TYPES) else id(value)


def _is_leaf_type(value: object) -> bool:
    return (
        isinstance(value, (int, float, complex, str, bytes, bytearray, bool, type(None)))
        or inspect.isroutine(value)
        or inspect.isclass(value)
        or inspect.ismodule(value)
    )


def _display_label(value: object) -> str:
    """The best short label for a value that isn't being structurally expanded
    (a leaf, a cut-short cycle, or a depth-capped object): the class name if it
    has no custom `__repr__` — skipping the ugly `<Module.Class object at
    0x...>` default entirely — otherwise the real repr."""
    if type(value).__repr__ is object.__repr__:
        return type(value).__name__
    return _safe_repr(value)


def _instance_attrs(value: object) -> dict:
    """Read an object's *stored* attributes only — never via dir()/getattr() over
    the class, which would invoke @property getters and could run arbitrary
    user code (with side effects) as a side-channel of merely inspecting state
    mid-trace."""
    d = getattr(value, "__dict__", None)
    if d is not None:
        return dict(d)
    slots = getattr(type(value), "__slots__", None)
    if not slots:
        return {}
    if isinstance(slots, str):
        slots = (slots,)
    result = {}
    for name in slots:
        try:
            result[name] = getattr(value, name)
        except AttributeError:
            pass  # unset slot
    return result


def capture_value(value: object, *, depth: int = 0, seen: frozenset[int] | None = None) -> dict:
    """Capture one local/global/return value for the event log.

    Primitives, functions, classes, and modules are captured as a plain
    repr+id leaf, same as always. Containers (list/tuple/set/frozenset/dict)
    and plain object instances are additionally expanded into structured
    `items`/`entries`/`fields` (recursively, up to MAX_DEPTH) so the UI can
    show what's *inside* them instead of a flat repr — critically important
    for objects with no custom `__repr__`, which otherwise show Python's
    `<Module.Class object at 0x...>` default.
    """
    seen = seen or frozenset()
    obj_id = _obj_id(value)

    if _is_leaf_type(value):
        return {"repr": _safe_repr(value), "id": obj_id}

    if id(value) in seen:
        return {"repr": _display_label(value), "id": obj_id, "circular": True}

    if depth >= MAX_DEPTH:
        return {"repr": _display_label(value), "id": obj_id, "truncated": True}

    next_seen = seen | {id(value)}

    if isinstance(value, dict):
        pairs = list(value.items())
        entries = [
            {
                "key": capture_value(k, depth=depth + 1, seen=next_seen),
                "value": capture_value(v, depth=depth + 1, seen=next_seen),
            }
            for k, v in pairs[:MAX_ITEMS]
        ]
        result = {
            "repr": f"dict ({len(value)})",
            "id": obj_id,
            "type": "dict",
            "entries": entries,
        }
        if len(pairs) > MAX_ITEMS:
            result["truncated"] = True
        return result

    if isinstance(value, _CONTAINER_TYPES):
        elements = list(value)
        items = [capture_value(v, depth=depth + 1, seen=next_seen) for v in elements[:MAX_ITEMS]]
        result = {
            "repr": f"{type(value).__name__} ({len(elements)})",
            "id": obj_id,
            "type": type(value).__name__,
            "items": items,
        }
        if len(elements) > MAX_ITEMS:
            result["truncated"] = True
        return result

    attrs = _instance_attrs(value)
    if not attrs:
        # No __dict__/__slots__ to show (e.g. some C-extension types) — fall
        # back to a plain leaf, same as today's behavior.
        return {"repr": _safe_repr(value), "id": obj_id}

    cls = type(value)
    label = _display_label(value)

    attr_pairs = list(attrs.items())
    fields = {
        name: capture_value(v, depth=depth + 1, seen=next_seen) for name, v in attr_pairs[:MAX_ITEMS]
    }
    result = {"repr": label, "id": obj_id, "type": cls.__name__, "fields": fields}
    if len(attr_pairs) > MAX_ITEMS:
        result["truncated"] = True
    return result
