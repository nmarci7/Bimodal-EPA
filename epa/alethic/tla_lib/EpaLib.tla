------------------------------- MODULE EpaLib -------------------------------
(***************************************************************************)
(* The small hand-written library every generated cone module extends.     *)
(*                                                                         *)
(* A token is a record                                                     *)
(*   [b |-> [ModeSet -> 0..10],  behavioural magnitudes per mode field     *)
(*    c |-> level,               confidentiality (join = max)              *)
(*    a |-> level,               authority (merge = min)                   *)
(*    t |-> BOOLEAN]             taint (merge = or)                        *)
(* An edge label is [u |-> used, n |-> exists on the normal flow, k |-> tok]*)
(* Labels only grow: merging never makes a token better, so every run      *)
(* ends in the least fixpoint of the propagation (the paper's Lemma).      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

Max(x, y) == IF x > y THEN x ELSE y
Min(x, y) == IF x < y THEN x ELSE y
Sat(v) == Min(v, 10)

RECURSIVE MaxSet(_)
MaxSet(S) == IF S = {} THEN 0 ELSE LET x == CHOOSE x \in S : TRUE IN Max(x, MaxSet(S \ {x}))

JoinTok(x, y) == [b |-> [f \in DOMAIN x.b |-> Max(x.b[f], y.b[f])],
                  c |-> Max(x.c, y.c),
                  a |-> Min(x.a, y.a),
                  t |-> x.t \/ y.t]

RECURSIVE JoinAll(_, _)
JoinAll(S, bot) == IF S = {} THEN bot
                   ELSE LET x == CHOOSE x \in S : TRUE IN JoinTok(x, JoinAll(S \ {x}, bot))

\* merge what a component sends into what its edge already carries
MergeLab(l, o) == IF o.u THEN [u |-> TRUE, n |-> l.n \/ o.n, k |-> JoinTok(l.k, o.k)] ELSE l

\* a token at least as bad as another, field by field
AtLeastAsBad(x, y) == /\ \A f \in DOMAIN x.b : x.b[f] >= y.b[f]
                      /\ x.c >= y.c /\ x.a <= y.a /\ (y.t => x.t)
=============================================================================
