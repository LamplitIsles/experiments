---
name: grove-research
description: Investigate a decision with claim-appropriate evidence, directly by default or through 2–4 independent Grove Researchers, then synthesize and archive in FlickNote.
---

# Research

Establish the exact question, the decision it informs and any value stance before gathering sources. Distinguish evidence-backed findings from interpretations and preferences. Read relevant repository context first. Search prior FlickNote knowledge across projects with MCP `note_find`, then `note_get`; recheck stale decision-relevant facts.

Resolve discoverable facts yourself. Ask the user only when unresolved ambiguity materially changes the conclusion; otherwise state the framing and proceed. For public social-media research, read the installed `opencli-usage` skill and discover the current adapters before querying. Use suitable first-party sources for owner-controlled facts; use the strongest suitable secondary evidence or direct experience when first-party material cannot answer a claim, stating its limits.

## Direct or parallel

Research directly by default. Delegate only when you can list **2–4 independent, decision-relevant research questions**, each answerable without another question's result and with distinct evidence scope. A single question split by source type or a generic background investigation does not meet this criterion.

For such a plan, discover the execution host's Grove MCP schemas and call `researcher_start` once per question with registered `project`, useful `title`, exact `question`, and a bounded `message` brief. Application configuration owns model/effort; skill invocations do not select them. Each brief names the decision, scope/exclusions, prior-note context and required evidence/source constraints. Keep Orc work non-overlapping: establish the comparison frame, inspect shared context or prepare synthesis.

Retain IDs and inspect `researcher_list/read` after an unknown admission before creating or sending again. Reports and questions arrive asynchronously at the owning Orc; continue independent work without polling. Use `researcher_send` on the same identity to clarify its question or answer explicit delegated `questionIds`. Pending closure accepts only answers to existing questions. If Grove research tools are unavailable, research directly and disclose any independent evidence gap.

Researcher returns evidence: verified facts and direct sources, source type/claim fit, interpretation or speculation, conflicts, unknowns and useful leads. It investigates without developing code, writing repository/FlickNote state, creating agents or making the final recommendation. These are role responsibilities, not hard tool or filesystem permissions.

## Synthesize and archive

Orc compares each report with the question, resolves or exposes conflicts and fills material gaps directly. Do not delegate one new Researcher for a single gap; either fill it directly or establish another independent 2–4-question plan. Stop when decision-relevant claims are supported or uncertainty is explicit.

Write one Markdown research note with question, findings, recommendation, trade-offs/value stance, unknowns and cited sources. Save using FlickNote MCP `note_add` without a `project` argument, then return title and ID. If MCP archival is unavailable, report that blocker without a note-management CLI or repository-file substitute. Researcher does not archive.

Request `researcher_close` when evidence and delegated questions are settled. `closing=true` is an accepted durable request; `closed=true` confirms real native release. Inspect waiting/report/delivery guards; retry an explicit release failure only after reading its evidence. `confirmInterrupted` acknowledges an inspected unknown turn, never an uncertain delivery. Restore preserves original thread, owner, question and captured configuration; unconfirmed work is never automatically replayed. Grove disables native collaboration for all managed roles; use Grove lifecycle tools.
