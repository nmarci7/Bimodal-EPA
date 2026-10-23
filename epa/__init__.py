"""EPA engine v2: bimodal error propagation analysis.

The alethic layer (what can happen in the runs of one candidate system) is a TLA+ model checked by
TLC; the epistemic layer (which candidate systems the evidence still allows) is an ASP program solved
by clingo; a coordinator connects them through a cache of explored runs.
"""
__version__ = "2.0.0"
