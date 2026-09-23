# zencodex

`zencodex` is a private, reader-first terminal conversation for Codex. Agent
output is a complete message, not a stream: the transcript contains only your
messages and completed assistant final answers. Completed messages are rendered
once into normal terminal scrollback; the live UI contains the composer and
status, not an ever-growing transcript widget tree. The input area is anchored
at the bottom from its first frame, before history arrives.

## Run

Prerequisites: Bun, a supported terminal, and a currently installed,
authenticated official `codex` command on `PATH`.

```sh
bun install
bun run --cwd zencodex start
```

Run it from the project directory whose Codex sessions you intend to use.
`zencodex` starts a new conversation directly. To choose an existing session,
open the resume list:

```sh
zencodex resume
```

The resume list contains existing sessions only. To resume a specific native
thread directly, bypassing the list and local history discovery:

```sh
zencodex resume <thread-id>
```

The explicit ID is sent to Codex in the current working directory. A missing,
busy, or otherwise rejected session exits with an error and nonzero status;
it never silently starts a new conversation. `zencodex --help` shows usage.

The resume list queries Codex's `state_5.sqlite` read-only, using its cwd/time index;
it does not walk rollout directories or maintain a second cache. The default is
`$CODEX_HOME/state_5.sqlite` (`~/.codex` when unset). User `config.toml`'s
`sqlite_home` takes precedence over `CODEX_SQLITE_HOME`. This local reader targets
the current Codex schema; incompatible/corrupt databases fail explicitly rather
than silently falling back to a history scan. A missing database gives an empty
resume list. Project/managed overrides of `sqlite_home`
are not resolved by this local index reader.

The composer appears while the unmodified `codex app-server`
from `PATH` connects and starts or resumes the thread. You may edit a draft immediately;
Enter/Tab leave it unsent until backend and history preparation finish. Loading
status makes this boundary explicit; exiting cancels preparation. The official
app-server remains authoritative for history, admission, turns and compaction.

New and resumed threads use Codex's native `approvalPolicy: never` and
`sandbox: danger-full-access` configuration. This intentionally autonomous v0
has no approval surface.

## Controls and boundaries

Enter submits immediately (steering a running turn); Tab queues a follow-up
while working and submits normally while idle. Follow-ups run FIFO, one per
turn. Esc interrupts the active turn; remaining follow-ups return to the input
draft rather than automatically running. The status shows the queued count.
Ctrl-J inserts a newline, Ctrl-C clears the unsent draft/completion, and Ctrl-D quits.
Exiting the reader prints a command to resume that session. Esc dismisses an
open completion popup. Completion popups consume Enter/Tab
before submission. The queue is local to the running process.
Completion suggestions temporarily use two of the composer's three rows;
opening and dismissing them does not resize or move the terminal footer.

Use terminal/Herdr scrollback for reading, selecting, copying and searching
retained output. zencodex no longer implements transcript search or match
highlighting. Use `flicklog search "query"` in another pane for saved conversation
search; Flicklog does not index tool output. No embedded history-search panel or
result-to-session navigation is provided.

Initial and source-refresh replay use a 1,000-rendered-row soft budget. The newest
message remains complete even if oversized; earlier messages form a contiguous
suffix at whole-message boundaries. Omitted history is marked explicitly.
History pages are fetched newest-first and expanded only while the replay
budget has room. Saved Codex history and model context are not truncated.
History is laid out offscreen and submitted as one snapshot above the input
area. Normal output follows the tail when the host is already at the bottom;
scrolling back/copy mode belongs to the host. zencodex does not clear saved
scrollback or request a jump to the bottom. Width changes leave existing output
to the terminal's reflow and render future messages at the new width, rather
than clearing/replaying history and disturbing a reading position. Previously
rendered Markdown is not semantically re-laid out on resize. A source correction
appends a labeled refreshed view while retaining the earlier terminal output.

Typing `/` offers `/compact`, `/cancel-retry`, and `/model`. Commands are
inserted before submission and run without adding chat text. `/compact`
requests native compaction; input entered during compression waits in order and
is released after completion. A failed or interrupted compaction clears the
wait and surfaces its error without discarding queued input. `/model <model>
<effort>` atomically updates the native thread's model and reasoning effort.
After typing `/model `, the picker offers only model/effort pairs supported by
the official `model/list` catalogue; it never uses a local model list.
Each model's advertised default effort appears first, and the combined label is
fuzzy-matchable, so `/model luna ma` can select a Luna/max pair. Typing `$`
offers enabled skills from the selected cwd's official `skills/list` result.
Arrows select; Enter or Tab inserts; Esc
dismisses. A skill selection inserts literal `$name `, leaving the caret after
the space, and never invokes a zencodex skill runtime. `skills/changed` only
invalidates the next official list request.

The fixed two-line status area shows cwd plus authoritative model/reasoning
effort, then native context telemetry and working duration. On resume it may
seed context only from the newest valid `token_count` in a bounded suffix of
the selected rollout; the first native token update wins. Missing evidence is
unavailable, never estimated. The title, model, and effort follow authoritative
thread updates. If another Codex client holds the thread writer, zencodex
closes its client and shows the error in the resume list; it never takes over,
forks, or creates a replacement session.

Markdown rendering stays in OpenTUI; terminal scrollback and copying belong to
the terminal host. Mouse reporting is disabled in conversation mode so the host
can handle scrolling and selection.

When Codex finishes a turn with `ServerOverloaded`, zencodex waits 15 minutes
before attempting to continue the existing native conversation. Repeated capacity
failures wait 30 minutes each, until success or cancellation. The status area
shows a countdown; `/cancel-retry`, a new manual submission, or closing the
conversation cancels the pending retry. Recovery does not replay accepted user
messages or switch models. If manual compaction failed due to capacity, recovery
retries that compaction before releasing waiting input. Other errors are shown
without scheduling capacity retries. Waiting is local to the open reader and
does not survive exit; the timer does not guarantee backend availability.

There is no streaming prose, reasoning/tools/diffs/images/plans, execution
inspector, durable zencodex transcript or queue, remote-session browser,
automatic compaction or compatibility layer. Do not edit
Codex logs to use zencodex.

When `HERDR_ENV=1` and `HERDR_PANE_ID` are present, lifecycle reporting is an
optional best-effort `working`/`idle`/`blocked`/release signal. Capacity waiting
reports `blocked` with the next retry time. Reporting failures appear in the
status area and cannot delay or change the conversation.
The reader owns that pane's lifecycle. Before both thread start and resume it
discovers Codex hooks and disables only the installed shell-based Herdr
`SessionStart` command (`bash`/`sh` running `herdr-agent-state.sh session`) through
per-session `hooks.state` overrides. It does not edit global hook configuration,
disable unrelated hooks, or clear `HERDR_PANE_ID`; embedded tools retain the
current pane environment. An applicable managed hook cannot be overridden and
produces an explicit error instead of starting with conflicting ownership.
Working, compaction, capacity wait, idle and release share one lifecycle
projection; queued input keeps the pane working across compaction completion.

This integration does not register native Herdr session restore: after a full
Herdr server restart, use `zencodex resume` or `zencodex resume <thread-id>`
to reopen zencodex. Ordinary
Herdr detach/reattach leaves the existing reader process running.

## Local performance traces

OpenTelemetry tracing is enabled by default. Set `ZENCODEX_TRACE=0` to disable it.
It records startup-to-resume-list and selection-to-conversation readiness, including
discovery, app-server, history-page, Markdown-layout and replay spans. Direct
new and ID-resume modes record launch-to-conversation readiness. Readiness means a frame has
been submitted with input handlers active, not physical terminal paint. User
time choosing a session is excluded from loading latency.
`reader.shell_first_frame` marks the early, draft-only UI; `reader.first_frame`
and the enclosing `session.load` finish only when sending is enabled.

Private OTLP JSON batches are stored in `~/.local/state/zencodex/traces/`.
Retention keeps the newest 32 batches, each at most 1 MiB. The SDK queue holds
at most 256 spans; the local exporter admits at most four pending batches.
Export is batched, normal shutdown flushes with a bounded wait, and abrupt
termination may lose pending spans. Export failures do not fail the conversation.
There is no collector, network export, daemon, or telemetry upload.

To inspect an offline waterfall, convert retained batches to Chrome Trace Event
JSON, then open that file in Perfetto (`ui.perfetto.dev`):

```sh
bun /path/to/experiments/zencodex/src/tracing.ts > /tmp/zencodex-trace.json
# An optional argument selects another directory containing OTLP batches.
# Focus on the latest completed loading operation, excluding later idle time:
bun /path/to/experiments/zencodex/src/tracing.ts \
  ~/.local/state/zencodex/traces session.load > /tmp/zencodex-load.json
```

The focused view names the operation and its stage tracks. Concurrent spans use
separate lanes rather than overlapping on one thread. Use `startup.session_list`
to inspect the latest resume-list startup, or `startup.new` for a direct new
conversation.

Original files remain standard OTLP JSON. The converter only prepares a viewer
artifact; OpenTelemetry owns span creation, parent context and timing. Records
contain stage names, counts, dimensions, outcomes and opaque run IDs, not prompts,
responses, titles, raw paths, credentials or raw RPC errors. Instrumentation is
for future diagnosis, without requiring a pre-refactor benchmark.

## Source-first implementation

This package directly adapts the OpenTUI reader controls from the sibling
`utterlog` package and independently usable TypeScript app-server lifecycle
and recovery behavior from `Codex-for-Love`. CFL is source-only: zencodex does
not bundle, invoke, require, pin, patch, or configure any CFL runtime,
app-server binary, hook, prompt, compaction customization, or release artifact.
The maintained app-server client is MIT licensed; its attribution is retained
in [NOTICE](NOTICE).
