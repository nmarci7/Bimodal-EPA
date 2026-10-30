% The epistemic layer for one cell: candidates, the runs each admits, statuses, evidence.
%
% Input facts
%   row(R)           an open row: of the cell's cone (crow(R)), or of the cone of a witness linked to it
%   crow(R)          a row of the cell's own cone; counts are projected onto these
%   llm(R)           an LLM row or a learned guard's row: never N (the LLM rule)
%   leak(R)          a guard's leak row;  decidable(R): its target is decidable from the edge
%   run(F)           a run explored by TLC: a use case and a switch vector
%   uc(F,U)          the run's use case;  fires(F,R): R is in the run's switch vector
%   uses(F)          the run sends a message over the observation point
%   reaches(F)       the failure reaches the observation point in that run
%   match(F,W)       the run matches witness W on the fields W logs
%   wrun(W,F)        a run of witness W's own cone; wrow(W,R): an open row of that cone;
%   wfires(W,F,R)    R is in that run's switch vector; wmatch(W,F): the run matches all W logged
%   cert(K,R,X)      certificate K states activation X (n, s, a) for row R
%   wit(W)           a witness
% The externals switch evidence on and off without grounding again (suspension, what-if).
#external cert_on(K) : cert(K,_,_).
#external wit_on(W) : wit(W).

% ---- candidates: one activation per open row ---------------------------------
1 { act(R,n); act(R,s); act(R,a) } 1 :- row(R).
:- act(R,n), llm(R).                          % the LLM rule
:- act(R,n), leak(R), not decidable(R).       % never only on a decidable target
:- cert_on(K), cert(K,R,X), row(R), not act(R,X).   % a certificate in force fixes a row

% ---- the runs a candidate admits ---------------------------------------------
violates(F) :- fires(F,R), act(R,n).
violates(F) :- run(F), crow(R), act(R,a), not fires(F,R).
admits(F) :- run(F), not violates(F).

% ---- status of the failure in this candidate (box / diamond over its runs) ----
some_use   :- admits(F), uses(F).
some_reach :- admits(F), reaches(F).
use_clean  :- admits(F), uses(F), not reaches(F).
status(x) :- not some_use.
status(n) :- some_use, not some_reach.
status(a) :- some_reach, not use_clean.
status(s) :- some_reach, use_clean.

usecase(U) :- uc(_,U).
some_use(U)   :- admits(F), uc(F,U), uses(F).
some_reach(U) :- admits(F), uc(F,U), reaches(F).
use_clean(U)  :- admits(F), uc(F,U), uses(F), not reaches(F).
status(U,x) :- usecase(U), not some_use(U).
status(U,n) :- some_use(U), not some_reach(U).
status(U,a) :- some_reach(U), not use_clean(U).
status(U,s) :- some_reach(U), use_clean(U).

% ---- witnesses: a remaining candidate has a run matching every witness in force
matched(W) :- admits(F), match(F,W).
% a linked witness is matched by a run of its own cone that the candidate admits
wviolates(W,F) :- wfires(W,F,R), act(R,n).
wviolates(W,F) :- wrun(W,F), wrow(W,R), act(R,a), not wfires(W,F,R).
matched(W) :- wrun(W,F), wmatch(W,F), not wviolates(W,F).
:- wit_on(W), not matched(W).


#show act/2.
#show status/1.
#show status/2.
#show admits/1.
