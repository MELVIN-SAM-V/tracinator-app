from __future__ import annotations

import inspect
from types import CodeType


def get_param_names(code: CodeType) -> set[str]:
    """Names bound as parameters at call time (positional, kwonly, *args, **kwargs).

    Order matters: co_varnames lists positional/kwonly params first, then
    *args' name (if CO_VARARGS), then **kwargs' name (if CO_VARKEYWORDS).
    Default-valued parameters need no special handling — by the time the
    `call` trace event fires, Python has already resolved defaults into
    frame.f_locals, so they're indistinguishable from explicitly-passed args.
    """
    idx = code.co_argcount + code.co_kwonlyargcount
    names = set(code.co_varnames[:idx])
    if code.co_flags & inspect.CO_VARARGS:
        names.add(code.co_varnames[idx])
        idx += 1
    if code.co_flags & inspect.CO_VARKEYWORDS:
        names.add(code.co_varnames[idx])
        idx += 1
    return names
