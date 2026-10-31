------------------------------- MODULE EpaLib -------------------------------
(***************************************************************************)
(* The small hand-written library every generated cone module extends.     *)
(*                                                                         *)
(* A token is a record                                                     *)
(*   [b |-> [ModeSet -> 0..10],  behavioural modes: 0 absent, 1 present,   *)
(*                               larger numbers on a refined scale         *)
(*    c |-> level,               confidentiality (join = max)              *)
(*    a |-> level,               authority (merge = min)                   *)
(*    t |-> 0..3]                taint: 0 clean, 1 internal, 2 external    *)
(*                               identified, 3 external open (join = max)  *)
(* A message on a queue is [n |-> on the normal flow, k |-> token]; the    *)
(* normal bit tells a guard whether it may drop the message.               *)
(* The monitor label of an edge is [u |-> used, n |-> normal, k |-> tok],  *)
(* the field-wise worst token the edge delivered over the run. It reads    *)
(* the run; no component reads it under fifo.                              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

Max(x, y) == IF x > y THEN x ELSE y
Min(x, y) == IF x < y THEN x ELSE y
Sat(v) == Min(v, 10)

RECURSIVE MaxSet(_)
MaxSet(S) == IF S = {} THEN 0 ELSE LET x == CHOOSE x \in S : TRUE IN Max(x, MaxSet(S \ {x}))

JoinTok(x, y) == [b |-> [f \in DOMAIN x.b |-> Max(x.b[f], y.b[f])],
                  c |-> Max(x.c, y.c),
                  a |-> Min(x.a, y.a),
                  t |-> Max(x.t, y.t)]

RECURSIVE JoinAll(_, _)
JoinAll(S, bot) == IF S = {} THEN bot
                   ELSE LET x == CHOOSE x \in S : TRUE IN JoinTok(x, JoinAll(S \ {x}, bot))

\* merge what a component sends into what its edge already carries
MergeLab(l, o) == IF o.u THEN [u |-> TRUE, n |-> l.n \/ o.n, k |-> JoinTok(l.k, o.k)] ELSE l

\* a token at least as bad as another, field by field
AtLeastAsBad(x, y) == /\ \A f \in DOMAIN x.b : x.b[f] >= y.b[f]
                      /\ x.c >= y.c /\ x.a <= y.a /\ x.t >= y.t

\* the heads leave every non-empty queue of the firing component
Pop(Q, ports) == [p \in DOMAIN Q |-> IF p \in ports /\ Q[p] # <<>> THEN Tail(Q[p]) ELSE Q[p]]

\* How many times a run has carried this value on one edge: S holds [m |-> value, c |-> count].
Carried(S, m) == IF \E x \in S : x.m = m THEN (CHOOSE x \in S : x.m = m).c ELSE 0

\* The stopping rule: an edge carries one token value at most k times in a run. A delivery the bound
\* blocks is recorded in `cut`, with its edge and token. `port` is the queue the edge ends in; "" for an
\* edge that leaves the cone.
Deliver(s, e, port, o, k) ==
  IF ~o.u THEN s
  ELSE LET m == [n |-> o.n, k |-> o.k]
           c == Carried(s.seen[e], m) IN
       IF c >= k THEN [s EXCEPT !.cut = @ \cup {[e |-> e, m |-> m]}]
       ELSE [q |-> IF port = "" THEN s.q ELSE [s.q EXCEPT ![port] = Append(@, m)],
             seen |-> [s.seen EXCEPT ![e] = {x \in @ : x.m # m} \cup {[m |-> m, c |-> c + 1]}],
             cut |-> s.cut,
             lab |-> [s.lab EXCEPT ![e] = MergeLab(@, o)]]
=============================================================================
