# FlickGrove interface

FlickGrove is an agent workbench: choose a host/project, open an Orc or Worker, read the conversation, and send or stop work. Desktop keeps the multi-host canvas beside a conversation; mobile prioritizes the session list and full-height conversation. Orc, Worker, tree, execution host and navigation node follow CONTEXT.md.

Use project-owned shadcn-svelte components in src/lib/components/ui and Lucide icons. DaisyUI has been removed. Keep a compact Inter-based dark surface, muted borders, blue primary actions and amber for attention states. Use one set of control sizes rather than repeated CSS overrides. Context decisions: FlickNote3159 and3160.

Interaction uses pointer actions and application shortcuts. N opens creation into project search. I focuses Composer when an Orc detail is open and the user is not editing text. Arrow keys locate one canvas node, Enter opens it, E expands it and F fits the canvas. The visible navigation marker wraps the full card. It is separate from an open detail and from Agent work status. Pointer actions do not create global focus highlights. Worker cards keep their narrower width; their smaller titles show at most two lines, with space reserved for the status row.

Tab is completion, not page traversal. In / command suggestions and $ skill search it accepts the current item without sending. With no candidate it keeps the input target. Shift+Tab does not introduce another navigation mode. Preserve IME and browser/system combinations. Esc handles the topmost search, dialog or detail once.

Skill search has its own query field, matches names/full descriptions with Organon ranking, and preserves the main draft until selection. Selection inserts the exact invocation at the saved caret; Escape restores the draft/caret. Enter only selects while searching, then sends in Composer; Shift+Enter adds a newline. Keep Send clickable and Stop separate; do not swap them based on draft emptiness.

Render incoming Worker reports as left-aligned, initially collapsed timeline cards, with sender and a short preview. Identify them by delivery source and reportingWorkerId joined to message ID, never by text prefixes. Expand to render full Markdown. Folded state stays in the component; no extra report copy is persisted. Keep delivery errors visible beside the affected operation.

Use Sonner for brief success feedback, including a three-second tree-close toast. Keep actionable errors beside the relevant operation. Closing detail does not close the tree; Stop interrupts Orc's observed turn, while Workers continue under the existing backend contract.

Verify behavior with the isolated browser fixtures, including desktop and390px mobile, long text, disconnected hosts, settings, question answers, Stop and quota. Tests must never exercise installed credentials or live model sessions. Legacy Penpot boards retain task-flow context; their old DaisyUI styling is superseded by this migration. Use rendered screenshots to assess the current theme.
