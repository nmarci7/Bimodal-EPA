"""Verdict words from the statuses the remaining candidates give a failure (Definition of a verdict).

  conflict       no candidate remains
  not exercised  no remaining candidate ever uses the observation point
  guarantee      every candidate: never           (K box not reaches)
  hope           every candidate: sometimes
  exposed        every candidate: always
  unchecked      the candidates disagree; the set of statuses is the advice
A candidate in which the point is never used counts as never once some candidate uses it.
"""

WORDS = ("guarantee", "hope", "exposed", "unchecked", "not exercised", "conflict")


def verdict_of(seen):
    if seen is None:
        return "conflict"
    s = set(seen)
    if s <= {"x"}:
        return "not exercised"
    s = {"N" if x == "x" else x for x in s}
    if s == {"N"}:
        return "guarantee"
    if s == {"S"}:
        return "hope"
    if s == {"A"}:
        return "exposed"
    return "unchecked"


def statuses_for_display(seen):
    if seen is None:
        return []
    s = {"N" if x == "x" else x for x in seen}
    if s == {"N"} and set(seen) == {"x"}:
        return []
    return [x for x in "NSA" if x in s]


def advice(verdict, seen):
    s = set(statuses_for_display(seen))
    if verdict == "unchecked":
        if s == {"N", "S"}:
            return "certify the guard: the candidates that say never differ only in rows a certificate can fix"
        if s == {"S", "A"}:
            return "collect a clean run: a witness of the failure not reaching would rule out always"
        return "certify the guard and collect a clean run"
    if verdict == "hope":
        return "mitigate and monitor: no evidence about an LLM row can make it never"
    if verdict == "exposed":
        return "redesign: the failure reaches the point in every run of every remaining candidate"
    if verdict == "not exercised":
        return "coverage gap: no use case sends a message over this point"
    if verdict == "conflict":
        return "the evidence contradicts itself: see the conflict sets"
    return ""
