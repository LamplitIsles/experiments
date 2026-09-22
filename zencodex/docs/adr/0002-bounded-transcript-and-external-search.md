---
status: accepted
---

# Keep interactive work bounded and delegate history search

Zencodex will reserve Tab for Codex-compatible follow-up input rather than focus
switching, follow Codex's terminal-scrollback approach to viewing and copying, and remove
in-TUI full-transcript search. Herdr copy mode serves retained terminal output;
Flicklog with Meilisearch serves saved conversation search, initially through
`flicklog search` in a separate pane. This replaces ADR-0001: complete historical
search must not require keeping the entire conversation laid out in the TUI.

## Input contract

The reference is the user's local Codex checkout at
`0562c66e80d79830882035ddc40fa1be27aaa497`, particularly
`codex-rs/tui/src/bottom_pane/chat_composer.rs` and
`codex-rs/tui/src/chatwidget/{input_flow,input_restore}.rs`.
For ordinary prompts, Tab queues while working and submits while idle; Enter
submits immediately, steering an active turn. Completion handling retains its
priority over submission. Plain queued prompts are consumed FIFO, one per next
turn, not merged into one follow-up. On ordinary user interruption, pending input
is restored into the composer rather than automatically starting the next job.
Supported command and input edge cases should follow that reference rather than
introducing a separate job-runner policy. This does not require adding every
Codex command or feature to zencodex.

## Consequences

- Bound active rendering and replay work rather than inventing a last-N-messages
  cutoff. Codex writes completed output into normal terminal scrollback, retains
  source history cells, and limits initial/resize replay rows. This is not a
  constant-memory guarantee. Source retention and measured memory costs must be
  evaluated separately from the live widget tree.
- Remove the in-TUI search corpus, match tracking, rendered-coordinate mapping,
  frame highlights, search navigation, and their dedicated tests. Normal Markdown
  styling, selection, and copying are not search highlighting and remain needed.
- Herdr search covers retained terminal output, not necessarily complete session
  history. The user has verified current copy-mode behavior; a changed rendering
  path needs a focused regression check, not rediscovery of that capability.
- Flicklog currently searches user/assistant text and compaction summaries, not
  tool output. Tool context remains separately retrievable; this decision does
  not promise arbitrary historical tool-output search.
- No embedded search panel or search-result-to-session navigation is included.
- Pidex is a possible future name for zencodex, not a separate project or source.

## Replay policy

Use a default soft budget of 1,000 rendered rows for session resume and
source-refresh replay. Always retain the latest message in full, even when it
alone exceeds that budget. Include preceding messages as a contiguous suffix,
at whole-message boundaries, while they fit; do not cut through Markdown or
skip a large intervening message to include older small ones. Show an explicit
notice when older history is omitted, directing history retrieval to Flicklog.
Do not add a configuration setting initially. This limits replay, not saved
history or model context, and deliberately does not impose a strict upper bound
on an exceptionally large latest message.

Normal completed messages append without replaying the backlog. Avoid loading
and laying out the entire backlog merely to discard its beginning; source
pagination and rendering costs must be considered separately.

The final reading-position decision supersedes resize-triggered replay: existing
output is left to host reflow, while future messages use the new width. zencodex
does not clear saved scrollback or reset the host viewport. A changed source
projection appends a labeled bounded refresh rather than erasing earlier output.

Accepted and implemented on 2026-09-22. README describes the replacement behavior.

## Performance observability requirement

Instrument the new implementation for future bottleneck diagnosis. Measuring the
old implementation or comparing this refactor's speedup is not a prerequisite.
Two user-facing operations are required: process launch to session-list readiness,
and session selection to conversation readiness. Readiness means the relevant
frame has been submitted and input handlers are active, not merely that data has
loaded; it does not claim to measure the terminal application's physical paint.
Time spent choosing a session is excluded from loading latency. Direct resume
records launch-to-conversation readiness instead of inventing a picker phase.

Record nested spans for renderer initialization; indexed discovery querying;
picker construction
and first frame; app-server connection/initialization, hook discovery and thread
start/resume; token-usage seeding; paginated history RPCs and projection; reader
construction, Markdown/layout, replay submission, and first usable frame.
Keep repeated history-page spans bounded by actual requests; aggregate per-file
scan counts and bytes rather than logging every session file.

Use structured local trace records with a process-run ID, operation/trace ID,
span ID and parent ID, stable span name, monotonic start offset and duration,
and success/error/cancel outcome. Include a schema version, build/version marker,
entry mode, terminal dimensions, and relevant work counts (files, bytes, pages,
turns, messages, replay rows and truncation) so comparisons are meaningful.
Separate the process-start elapsed baseline from the first instrumented JS
milestone: runtime/module startup must not silently disappear from reported
launch latency. Parent durations include children; overlapping child durations
must not be summed as end-to-end time.

Use OpenTelemetry traces with default-on, bounded local retention, batched export,
and an explicit disable option, not a mandatory remote telemetry service. JSONL
is not a fixed storage contract: select a supported export path that preserves
standard trace semantics and can be inspected in an existing trace viewer.
Do not log prompts, responses, titles, raw paths, credentials, raw RPC bodies,
or unfiltered error messages. Record safe error classifications and use opaque
per-operation identifiers rather than persisted conversation identifiers.
Telemetry failures must not prevent launching or loading a session, must not
write over the TUI, and must not create an unbounded queue or file. The local
destination, rotation limits, and startup-clock API remain implementation details
to verify. Tests must inject a sink/clock or use test-owned paths.

The bottom-bar field called `telemetry` is display text, distinct from this tracing
facility. Trace completeness and non-disruptive
logging need focused checks, not an old-version benchmark campaign. No remote
collector or dashboard is required for this first scope.

OpenTelemetry trace is selected; LogTape/Pino plus a custom span model is rejected.
Use the standard span lifecycle, parent context, status and exporter interfaces.
Bun async-context propagation and OTLP serialization are covered by isolated
tests. Standard OTLP batches are written atomically with bounded retention;
a small offline converter prepares Chrome Trace Event JSON for Perfetto without
a service. SDK batching owns the span queue; file admission and shutdown wait
are bounded. No custom span/context model is introduced. Any need for an always-running
collector, remote upload, or additional service deployment requires a new explicit
decision; none is authorized by this selection.

## Source findings and remaining verification

At the reference revision, `tui/src/tui.rs` uses an inline viewport and inserts
history into normal scrollback. `app/history_ui.rs` also retains `HistoryCell`s;
`app/resize_reflow.rs` renders backward from the tail to enforce a replay row cap.
`resize_reflow_cap.rs` selects terminal-specific defaults; the fallback is 1,000
rows, and an explicit zero disables the cap. These are replay limits, not a
last-N-messages policy or proof of bounded total memory.

The previous reader used OpenTUI's default alternate screen and retained message
views in a scroll box. The replacement uses the installed OpenTUI's `split-footer`,
`writeToScrollback` and `createScrollbackSurface`. The destructive
`resetSplitFooterForReplay` path was removed after the reading-position review.
Prefer verifying those existing capabilities before considering a renderer
replacement. Herdr's `src/app/input/copy_mode.rs` searches retained terminal text
and already supplies `/`, `?`, `n`, and `N`; highlighting belongs there.

Current zencodex does not display streaming assistant text: `conversation.ts`
does not subscribe to text deltas, stages completed `final_answer` items, and
adds their combined body to `visible` only when the turn completes successfully.
Commentary is not projected. `cli.ts` polls this projection every 200 ms; that is
UI refresh, not text streaming. The existing atomic-final projection test passes.
Preserve this behavior; streamed Markdown row commits are out of scope.

## Verification checkpoint

Isolated tests now verify Bun async parent-context isolation across concurrent
operations with the OpenTelemetry SDK and its AsyncLocalStorage context manager,
and serialization with the official `JsonTraceSerializer` into OTLP JSON. SDK
2.11 uses `new SimpleSpanProcessor({ exporter })`, not the older positional API.
Application startup, discovery, loading and rendering now use those spans.

OpenTUI tests verify single complete-text commits, disposal of committed
renderables, continued footer rendering, complete non-streaming Markdown, and
increased measured row count after narrowing the terminal. Markdown must settle
before commit: rendering immediately can produce blank rows. Explicit snapshot
dimensions matter for `writeToScrollback`; measured Markdown uses a scrollback
surface instead. These tests do not read live sessions or write live state.

A test-owned PTY smoke exercised real-terminal reset, initial Markdown and
appended output without connecting a model or reading live sessions. Mouse
reporting is disabled in conversation mode, leaving scrolling/selection to the
host. Automated reader tests cover replay omission, complete oversized messages,
append deduplication, completion priority and restored drafts. This is not a
claim of a measured performance improvement or a manual Herdr UI acceptance run.

## Follow-up: indexed discovery and early reader

The local Codex source defines `state_5.sqlite` in `state/src/sqlite.rs` and
cwd/time indexes in `state/migrations/0027_threads_cwd_sort_indexes.sql`.
`state/src/runtime/threads.rs` applies an exact cwd SQL predicate. Discovery now
reads this database without writes, filtering archived and non-user threads;
the rollout-prefix scanner and separate title-index merge are removed. The
local path resolver handles user config and environment overrides, not Codex's
full project/managed config stack. Missing state permits starting a new session;
incompatible schema or corrupt state is surfaced, not scanned around.

The reader shell and backend connection start concurrently. Draft editing is
available on the early frame; sending remains gated until thread admission,
history loading and bounded replay complete. Cancellation aborts the client and
disposes the reader. Trace distinguishes the early shell frame from send-ready
readiness. No model request is made implicitly from a draft entered while loading.

A real PTY reproduced OpenTUI retaining the top coordinate when a split-footer
shrinks: a 7 → 9 → 7 cycle moved its bottom from row 24 to row 22. Suggestions
now borrow two composer rows within a constant seven-row surface. The same PTY
cycle keeps the bottom at row 24 throughout; offscreen layout alone did not
detect this bug.

The offline trace converter can focus on the latest named operation and labels
its tracks. Overlapping sibling spans receive separate lanes; late callbacks
outside that operation's lifetime are excluded only from the focused view.

## First-frame anchoring and host reading position

A second PTY probe started with no history and reproduced footer bottoms at
rows 8, 10, then 24 as history arrived in a 24-row terminal. The reader now
reserves the upper output area before its first frame; growing the terminal
extends that reservation without erasing retained output. Empty, short and long
history all keep the footer bottom fixed. Completion continues to borrow composer
rows, rather than changing the terminal surface height.

History selection and Markdown layout share one offscreen surface; the selected
whole-message suffix is committed as one snapshot, not many per-message commits
subject to the renderer's per-frame batch limit. Renderables are released after
commit. Host copy/scroll mode is independent from this live surface; a footer
anchored in the live screen does not remain overlaid when the host displays an
older viewport.

The automated POSIX test runs the actual reader in a Bun PTY and feeds its ANSI
output to xterm-headless. It checks the empty shell at the bottom, history above
it, completion, a manually scrolled viewport staying put through new output,
history retention through resize, and the live footer at the new bottom. This
replaces private-coordinate-only checks and does not touch live user sessions.
Herdr's PTY path feeds its terminal without calling its explicit scroll-reset
operation; copy mode intercepts reading keys. This is source verification of
Herdr, not a claim to have controlled the user's live Herdr UI.
