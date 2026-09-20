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

- Enter submits the multiline composer; a normal active turn receives a native
  steer. Ctrl-C stops an active turn or exits while idle.
- `/compact` invokes native compaction and is never displayed as chat text.
- The footer shows only server-reported active-window `totalTokens / context
window`; unavailable means the server has not supplied a usable observation.
- Ctrl-/ is reserved for transcript search (with `n`/`N` result navigation);
  `j`/`k`, arrows, Ctrl-D/Ctrl-U, `gg`, and `G` retain reader scrolling; `/` remains available to Codex
  slash commands. The reader retains OpenTUI Markdown, scroll, and OSC 52 copy
  behavior adapted directly from `utterlog`.

There is no streaming prose, reasoning/tools/diffs/images/plans, execution
inspector, durable zencodex transcript or queue, remote-session browser,
automatic compaction, model selector, or compatibility layer. Do not edit
Codex logs to use zencodex.

When `HERDR_ENV=1` and `HERDR_PANE_ID` are present, lifecycle reporting is an
optional best-effort `working`/`idle`/release signal. It cannot delay or change
the conversation.

## Source-first implementation

This package directly adapts the OpenTUI reader controls from the sibling
`utterlog` package and independently usable TypeScript app-server lifecycle
and recovery behavior from `Codex-for-Love`. CFL is source-only: zencodex does
not bundle, invoke, require, pin, patch, or configure any CFL runtime,
app-server binary, hook, prompt, compaction customization, or release artifact.
The maintained app-server client is MIT licensed; its attribution is retained
in [NOTICE](NOTICE).
