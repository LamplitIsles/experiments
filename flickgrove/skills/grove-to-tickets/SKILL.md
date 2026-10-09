---
name: grove-to-tickets
description: Break a plan, spec, or conversation into FlickNote implementation tickets with explicit blocking edges.
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it. When the source is a spec, every ticket belongs to that spec's single PR; tickets are execution units on one feature branch, not PR boundaries.

Create one FlickNote note per new ticket through MCP `note_add`, numbered from `01` in dependency order. The leading H1 becomes the note title; the stored `content` is the ticket body. Each note names its repository and feature, and records dependencies as `Blocked by:` using ticket note IDs. Use `Status: ready-for-agent` for newly published tickets. Omit the `project` argument unless the user requests a destination. Do not create remote tracker issues.

If FlickNote MCP cannot create or read the tickets, report the blocker.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. A numeric spec ID or `#ID` refers to a FlickNote note: read its `content` with MCP `note_get`. For other external references, ask for relevant content when no authorized reader is available.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Prefactor only when it directly unlocks the requested slice. Fold it into that ticket when feasible rather than creating preparatory architecture work.

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any necessary prefactoring is the minimum needed to unlock a requested slice

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately. Do not add a blocking edge merely to force a comfortable execution order: independent tickets should remain on the same frontier so the sole implementation Worker can choose the next unblocked slice.

Treat the current repository — monorepo or otherwise — as the default atomic change boundary. For a cross-cutting mechanical edit, prefer one ticket or independently green end-to-end slices. Introduce temporary old/new forms only when there is evidence of an external consumer or a real multi-deployment boundary that cannot change atomically.

### 4. Finalize the breakdown

Choose the granularity and blocking edges yourself from the vertical-slice rules. Do not ask the user to approve, merge, or split routine ticket boundaries. Ask only when an unresolved product decision changes what the tickets deliver; otherwise proceed directly to publication.

### 5. Publish the tickets

For a spec, create one note per ticket in dependency order. Add the returned IDs to a `## Tickets` section in the spec note after all notes exist. Each ticket references the spec ID, and its `Blocked by:` lists the prerequisite ticket IDs and titles. For tickets drafted directly from a conversation or plan, omit the spec reference and do not invent one. Read back the notes to verify their content and links. Keep all tickets for one spec on the same feature branch for one PR.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

<ticket-template>

# <NN> — <Ticket title>

Repository: <repository identifier>
Feature: <slug>
Spec: #<note ID, only when sourced from a spec>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

**Blocked by:** the IDs/titles of the tickets that gate this one, or "None — can start immediately".

Status: ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</ticket-template>

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.
