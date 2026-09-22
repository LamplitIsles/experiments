# zencodex

`zencodex` is a private, reader-first terminal conversation for Codex. Agent
output is a complete message, not a stream: the transcript contains only your
messages and completed assistant final answers. A submission becomes the
reading origin near the top of the viewport; working events and final answers
do not pull that position away.

## Run

Prerequisites: Bun, a supported terminal, and a currently installed,
authenticated official `codex` command on `PATH`.

```sh
bun install
bun run --cwd zencodex start
```

Run it from the project directory whose Codex sessions you intend to use.
To resume a specific native thread directly, bypassing the picker and local
history discovery:

```sh
zencodex --resume <thread-id>
```

The explicit ID is sent to Codex in the current working directory. A missing,
busy, or otherwise rejected session exits with an error and nonzero status;
it never silently starts a new conversation. `zencodex --help` shows usage.

Before launch, zencodex reads only bounded `session_meta` prefixes plus the
small native `session_index.jsonl` metadata index to populate the exact-cwd
picker; it never scans message content or writes a cache. After selection it
launches your unmodified `codex app-server` from `PATH` for that cwd. The official app-server remains
the sole authority for session discovery, history, active turns, execution and
compaction.

New and resumed threads use Codex's native `approvalPolicy: never` and
`sandbox: danger-full-access` configuration. This intentionally autonomous v0
has no approval surface.

## Controls and boundaries

zencodex has two focus regions. It opens in **COMPOSING**: Enter submits,
Ctrl-J inserts a newline, and Tab moves to **READING**. In READING, `/` starts
literal rendered-transcript search; `j`/`k`, arrows, Ctrl-D/Ctrl-U, `gg`, `G`, and
`n`/`N` navigate without taking composition keys. Literal text remains searchable
across Markdown formatting and visual wrapping. Matches are visibly marked and
the active result is distinct. Tab returns to COMPOSING. In COMPOSING,
Ctrl-C clears only the unsent draft and completion popup, while Ctrl-D quits.
In READING, Ctrl-D pages down and Ctrl-C is a no-op; zencodex has no keyboard
turn-interrupt or exit command on Ctrl-C.

Typing `/` offers `/compact` and `/cancel-retry`. Commands are inserted before
submission and run without adding chat text. `/compact` requests native
compaction; input entered during compression waits in order and is released
after completion. A failed or interrupted compaction clears the wait and
surfaces its error without discarding queued input. Typing `$` offers enabled
skills from the selected cwd's official `skills/list` result. Arrows select;
Enter or Tab inserts; Esc dismisses. A skill selection inserts literal `$name`
and never invokes a zencodex skill runtime. `skills/changed` only invalidates
the next official list request.

The fixed two-line status area shows cwd plus authoritative model/reasoning
effort, then native context telemetry and working duration. On resume it may
seed context only from the newest valid `token_count` in a bounded suffix of
the selected rollout; the first native token update wins. Missing evidence is
unavailable, never estimated. The title, model, and effort follow authoritative
thread updates. If another Codex client holds the thread writer, zencodex
closes its client and returns safely to the picker; it never takes over, forks,
or creates a replacement session.

The reader retains OpenTUI Markdown, scroll, and OSC 52 copy behavior adapted
directly from `utterlog`.

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
automatic compaction, model selector, or compatibility layer. Do not edit
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
Herdr server restart, use the picker or `--resume` to reopen zencodex. Ordinary
Herdr detach/reattach leaves the existing reader process running.

## Source-first implementation

This package directly adapts the OpenTUI reader controls from the sibling
`utterlog` package and independently usable TypeScript app-server lifecycle
and recovery behavior from `Codex-for-Love`. CFL is source-only: zencodex does
not bundle, invoke, require, pin, patch, or configure any CFL runtime,
app-server binary, hook, prompt, compaction customization, or release artifact.
The maintained app-server client is MIT licensed; its attribution is retained
in [NOTICE](NOTICE).
