"""Read TLC's state dump (`-dump states`): every distinct state as `/\\ var = value` lines.

TLC prints values in TLA+ syntax, so a small recursive-descent parser suffices: integers, booleans,
strings, records [a |-> v], functions (d :> v @@ ...), sets {..} and sequences <<..>>.
"""
from __future__ import annotations

import re

_TOK = re.compile(r'\s*(<<|>>|\|->|:>|@@|"(?:[^"\\]|\\.)*"|-?\d+|TRUE|FALSE|[A-Za-z_][A-Za-z0-9_]*|[\[\]{}(),])')


def _tokens(s):
    pos, out = 0, []
    while pos < len(s):
        m = _TOK.match(s, pos)
        if not m:
            if s[pos:].strip() == "":
                break
            raise ValueError(f"cannot parse TLA+ value near: {s[pos:pos + 40]!r}")
        out.append(m.group(1))
        pos = m.end()
    return out


class _P:
    def __init__(self, toks):
        self.t, self.i = toks, 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self, x=None):
        tok = self.t[self.i]
        if x is not None and tok != x:
            raise ValueError(f"expected {x}, got {tok}")
        self.i += 1
        return tok

    def value(self):
        tok = self.peek()
        if tok == "[":
            self.take("[")
            rec = {}
            if self.peek() == "]":
                self.take("]")
                return rec
            while True:
                key = self.take()
                self.take("|->")
                rec[key.strip('"')] = self.value()
                if self.peek() == ",":
                    self.take(",")
                    continue
                self.take("]")
                return rec
        if tok == "{":
            self.take("{")
            items = []
            while self.peek() != "}":
                items.append(self.value())
                if self.peek() == ",":
                    self.take(",")
            self.take("}")
            return frozenset(items) if all(isinstance(x, (str, int, bool)) for x in items) else tuple(items)
        if tok == "<<":
            self.take("<<")
            items = []
            while self.peek() != ">>":
                items.append(self.value())
                if self.peek() == ",":
                    self.take(",")
            self.take(">>")
            return tuple(items)
        if tok == "(":
            self.take("(")
            fn = {}
            while True:
                k = self.value()
                self.take(":>")
                fn[k] = self.value()
                if self.peek() == "@@":
                    self.take("@@")
                    continue
                self.take(")")
                return fn
        self.take()
        if tok == "TRUE":
            return True
        if tok == "FALSE":
            return False
        if tok.startswith('"'):
            return tok[1:-1]
        try:
            return int(tok)
        except ValueError:
            return tok


def parse_value(s):
    return _P(_tokens(s)).value()


def parse_labels(s, cache):
    """The edge labels of a state, `("e1" :> [..] @@ "e2" :> [..])`, parsed edge by edge. Many runs
    leave an edge with the same label, so each distinct label text is parsed once (`cache`)."""
    s = s.strip()
    if not (s.startswith("(") and s.endswith(")")):
        return parse_value(s)
    out = {}
    for part in s[1:-1].split("@@"):
        key, val = part.split(":>", 1)
        val = val.strip()
        rec = cache.get(val)
        if rec is None:
            rec = cache[val] = parse_value(val)
        out[key.strip().strip('"')] = rec
    return out


def read_dump_raw(path):
    """Yield each state as {variable: value text} without parsing the values."""
    cur, key, buf = None, None, []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("State ") and line.endswith(":"):
                if cur is not None:
                    if key is not None:
                        cur[key] = " ".join(buf)
                    yield cur
                cur, key, buf = {}, None, []
            elif line.startswith("/\\ "):
                if key is not None:
                    cur[key] = " ".join(buf)
                key, val = line[3:].split(" = ", 1)
                buf = [val]
            elif line.strip() and cur is not None:
                buf.append(line.strip())
        if cur is not None:
            if key is not None:
                cur[key] = " ".join(buf)
            yield cur


def read_dump(path, wanted=None):
    """Yield one dict per state. `wanted` limits which variables are parsed (the rest stay text)."""
    cur, key, buf = None, None, []

    def flush():
        if cur is not None and key is not None:
            text = " ".join(buf)
            cur[key] = parse_value(text) if (wanted is None or key in wanted) else text

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("State ") and line.endswith(":"):
                flush()
                if cur is not None:
                    yield cur
                cur, key, buf = {}, None, []
            elif line.startswith("/\\ "):
                flush()
                key, val = line[3:].split(" = ", 1)
                buf = [val]
            elif line.strip() and cur is not None:
                buf.append(line.strip())
        flush()
        if cur is not None:
            yield cur
