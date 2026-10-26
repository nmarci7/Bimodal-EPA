# TDK arc

This document draws the arc of the TDK paper, with each chapter and section spanned out as why it is relevant, what questions shall it answer and what key concepts shall it introduce. 

## Introduction

This is the hook for the paper - it shall introduce the relevance to the problem of agents going rouge - maybe with the hugging face or the MCP example. 

It shall also state the contributions in one paragraph - inputs of the tool, reasoning dynamically in TLA+ and overall in ASP and the the outputs - giving verdict to the analyst, to act on - how may one act on it design time (implement guardrails) and what needs to be checket (guarantee, hope, leaking)

Finally in one paragraph it shall introduce the structure of the paper - chapters and their contents in one sentence. 

## Background 

The goal here is to define the existing theories - building blocks only in depth that the paper build on - so that later these concepts can be used without elaboration. 5 topics to introduce and their relevance: 

1. Agentic AI and agentic systems
- What is an LLM? 
- What is agentic AI and how it differs from an LLM? 
- What are the key risks with agents? 
- How are they introduced in systems nowadays? (payment, customer service, MCP, smart home)

2. Error Propagation Analysis
- What does classical Error Propagation Analysis mean, why did people do it? (model time checks for critical systems)
- What is the classical input and output of an EPA? (model, component level error tables, the error token as a concept, connections between components throughout the analysis)
- LaPrie's fault error failure model
- classical fault modes in a given system (timeliness, value, ...)

3. Alethic and epistemic logic
- What EPA does not cover - the two mays
- How can the two mays be represented - knowledge and system behaviour
- How came alethic and epistemic logic from propositional logic - the possible worlds model, where the analyst cannot differentiate between runs in the system
- what exactly is alethic logic? notation - the square and diamond
- what exactly is epistemic logic? notation - the K

4. ASP and TLA+
- What is answer set programming? logic programming language
- Why using answer set programming - the expressing power and the ability to explain knowledge
- How does an asp statement look like? head :- body, evaluation of a statement. 
- What is TLA+
- Why do we use TLA+ for dynamic modelling? 
- TLA+ capabilities and the power of dynamic modelling 
- basic TLA+ syntax used. 

5. Cyber Resilience Act
- What is CRA? 
- Why is it relevant for developed software
- how the tool aids CRA? 

## Theoretical framework

This section defines my mathematical formulation of the tool's engine. It's purpose is to create a SOUND, ROCK SOLID mathematical framework for the tool, basically the core of the whole document. 

1. The model
- How does a model look like that the tool reasons above? 
- What is a component? - how it is built up (ports, error connection tables)
- What is an edge? 
- How are LLM-s defined? - special component
- what is a guardrail? - special component living on edges

2. What happens in the model? 
- What is an error token, how is it built up? 
- What is a use case? 
- How does a propagation work? 

3. Reasoning
- After a use case is simulated what data is gathered? 
- What is a run? 
- What is a candidate? 
- what is a witness?
- what is a certificate? 
- How can we infer from these - what do we infer, what does the analyst see? (alethic and epistemic factors here!!!!)

4. Verdicts
- What are verdicts? 
- Analyses and further use
- how are actions ranked? 

5. Assumptions made in the model

## The tool 

This chapter's purpose is to ellaborate how the actual tooling works: 
from input and analyst knowledge to inference and outputs that are useable. This section does not go into detail with the mathematics, rather the ASP and TLA+ programming, with the actual use and engineer level implementation of the theory. 

1. General use of the tool - few words about how it is used, and what components it is built of. an overview figure is needed here, as the later sections only ellaborate on the components. 

2. Inputs 
System model - what happens if there is none? 
witnesses - system logs and traces
certificates - analyst statements
connections for the agent, MCP

HOW are these inputs received (on actual JSON / logfile.txt levels), how are these inputs transformed to ASP and TLA+ (deterministic python script??)

3. Tool
- What is the ASP layer for? How it reasons what one reasoning looks like? epistemic layer!!
- What is TLA+ used for how are dynamic models contribute? (alethic layer!!)
- Verdict table - data store, which component uses which part, problems like execution space explosion, updates in the table, how a single row looks like, what updates this table? 

4. Output
- What does the analyst see, how can they overwrite the result, how can it help prepare for CRA audit or complyability? 
- What happens after actions are taken? Inputted modifications, re verification

## Demonstrative cases, evaluation

1. Smart home hub
- System model uploaded - human interacts with an agent that interacts with smart home controller. 
- What the verdicts are for the model, how can be improved? 

2. Delegated wallet agent
- OTP completeing its first payment in 2026 spring
- System model uploaded - human sets the payees as whitelist and the amounts - incoming invoices are handled by agent
- What the verdicts are for the model, how can be improved? 

3. MCP programming setup
- the case from the introduction - programming on open repo, agent takes PR desc as command, outputs the owners private data. 
- What the verdicts are for the model, how can be improved? 

## Conclusion

- What was covered in the paper? 
- How did it the tool do? What are its capabilities and what are not? 
- Future work - what can be covered what are the known missing gaps? 


