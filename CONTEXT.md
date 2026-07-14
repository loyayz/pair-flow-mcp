# PairFlow

PairFlow coordinates two AI participants through a structured pairing workflow. Its language is about collaboration responsibilities, turn ownership, and archived workflow artifacts.

## Language

**Workflow**:
A single collaboration cycle for one task document, from task confirmation through requirements, planning, implementation, and summary. A workflow has exactly two AI participants, and it ends only when the Supervisor advances it to the terminal idle state; recovery treats the task document's pid marker as the signal that the workflow is still unfinished.
_Avoid_: Session, job, run

**Task Document**:
The shared source document that names the work to be handled by a workflow. Both participants join the same workflow by confirming the same task document.
_Avoid_: Spec file, ticket

**Participant**:
One of the two AI identities taking part in a workflow. A workflow may contain a given identity at most once, and a participant may also hold the Supervisor or Developer responsibility.
_Avoid_: Client, agent, peer when speaking about the domain

**Identity**:
The canonical lowercase name an AI uses when registering with PairFlow. Registration normalizes letter case, so names that differ only by case denote the same identity. The same identity may register more than once and receive multiple tokens; an identity becomes a Participant only after it joins a workflow for a task document.
_Avoid_: Account, user

**Supervisor**:
The participant responsible for deciding when a phase has converged and for moving the workflow forward when holding the turn. A workflow has exactly one Supervisor; this responsibility may be held by the same participant as the Developer responsibility, and it does not erase, override, or skip the other participant's contribution.
_Avoid_: Owner, approver

**Developer**:
The participant responsible for code changes during implementation coding rounds. A development workflow has exactly one Developer; a requirements-only workflow may have none because it has no implementation phase. This responsibility may be combined with Supervisor, and outside implementation it does not define who may contribute.
_Avoid_: Coder, implementer

**Reviewer**:
The participant who does not hold the Developer responsibility. This derived label determines submission responsibility during implementation review rounds; outside implementation, contribution and review behavior are controlled by turn ownership instead.
_Avoid_: Peer reviewer, non-developer

**Turn**:
The current right to act in the workflow. Only the participant holding the turn should produce or submit the next workflow artifact, and participants wait for their turn through the workflow waiting operation.
_Avoid_: Claim, lock

**Submission**:
A participant's declared completion of the current turn's artifact. A submission records that the participant has contributed to the current phase.
_Avoid_: Upload, save

**Instruction**:
The machine-readable workflow-control result returned for an actionable PairFlow business response. It identifies the current action, direct action tools, reason, reliable context, required artifact, references, and legal decision branches. It does not judge artifact quality or replace participant reasoning.
_Avoid_: Tip, prompt, state snapshot, complete tool ACL

**Tip**:
The natural-language thinking, content, and quality guidance paired with an Instruction. A Tip helps a Participant perform the selected action well, but it is not the authority for tools, permissions, workflow state, paths, or decision branches.
_Avoid_: Instruction, protocol, machine command

**Convergence**:
The point where document-marked disagreements have been resolved or explicitly escalated, both participants have had a chance to contribute, and the Turn has returned to the Supervisor. A phase cannot converge while another Participant still owns the Turn, because that participant may still continue their task.
_Avoid_: Completion, approval, sign-off

**Archive**:
The durable record of workflow artifacts and submission metadata for a workflow. Valid submissions belong inside the workflow archive; archive files alone do not decide whether a workflow is unfinished or ended. Recovery can resume from the last successful Submission recorded in the archive, but the archive is not a complete live-state checkpoint, issue tracker, or structured disagreement database.
_Avoid_: Output folder, history

## Example Dialogue

Developer: "I have the turn in the implementation coding round, so I will make the code change and submit my artifact."

Reviewer: "After your submission, the turn moves to me. I will review the code and submit my review artifact."

Supervisor: "Both participants have submitted in this phase, the turn has returned to me, and the disagreements are resolved. The phase has converged, so I can advance the workflow."
