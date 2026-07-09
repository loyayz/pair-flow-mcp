# PairFlow

PairFlow coordinates two AI participants through a structured pairing workflow. Its language is about collaboration roles, turn ownership, and archived workflow artifacts.

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
The name an AI uses when registering with PairFlow. The same identity may register more than once and receive multiple tokens; an identity becomes a Participant only after it joins a workflow for a task document.
_Avoid_: Account, user

**Supervisor**:
The participant responsible for deciding when a phase has converged and for moving the workflow forward when holding the turn. A workflow has exactly one Supervisor; this responsibility may be held by the same participant as the Developer responsibility, and it does not erase, override, or skip the other participant's contribution.
_Avoid_: Owner, approver

**Developer**:
The participant responsible for code changes during implementation coding rounds. A workflow has exactly one Developer; this responsibility may be combined with Supervisor, and outside implementation, including requirements-only workflows, it does not define who may contribute.
_Avoid_: Coder, implementer

**Reviewer**:
The non-Developer participant when the workflow is in an implementation review round. Outside implementation, review behavior is controlled by turn ownership rather than this label.
_Avoid_: Peer reviewer, non-developer

**Turn**:
The current right to act in the workflow. Only the participant holding the turn should produce or submit the next workflow artifact, and participants wait for their turn through the workflow waiting operation.
_Avoid_: Claim, lock

**Submission**:
A participant's declared completion of the current turn's artifact. A submission records that the participant has contributed to the current phase.
_Avoid_: Upload, save

**Convergence**:
The point where document-marked disagreements have been resolved or explicitly escalated, both participants have had a chance to contribute, and the turn has returned to the Supervisor. Summary convergence still requires participation from both AI participants.
_Avoid_: Completion, approval, sign-off

**Archive**:
The durable record of workflow artifacts and submission metadata for a workflow. Valid submissions belong inside the workflow archive; archive files alone do not decide whether a workflow is unfinished or ended. Recovery can resume from the last successful Submission recorded in the archive, but the archive is not a complete live-state checkpoint, issue tracker, or structured disagreement database.
_Avoid_: Output folder, history

## Example Dialogue

Developer: "I have the turn in the implementation coding round, so I will make the code change and submit my artifact."

Reviewer: "After your submission, the turn moves to me. I will review the code and submit my review artifact."

Supervisor: "Both participants have submitted in this phase, and the disagreements are resolved. The phase has converged, so I can advance the workflow."
