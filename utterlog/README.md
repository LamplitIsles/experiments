# utterlog

utterlog is a small Bun/TypeScript CLI for rereading named local Codex sessions. Run it in a project directory, choose a session with the installed `fzf`, and it opens a read-only Markdown transcript in `$EDITOR`.

## Requirements and setup

- Bun
- `fzf` on `PATH` (this personal tool uses the existing `/run/current-system/sw/bin/fzf`, version 0.62.0)
- An editor command in `$EDITOR`

Install the tool once:

```sh
cd /path/to/experiments/utterlog
bun install
```

Run it from the directory whose sessions you want to read. Invoking the entry point by its absolute path keeps the caller's directory unchanged for matching:

```sh
cd /path/to/project
EDITOR='hx' bun /path/to/experiments/utterlog/src/cli.ts
```

To use `utterlog` as a command, link this private package after installing it:

```sh
cd /path/to/experiments/utterlog
bun link
cd /path/to/project
EDITOR='code --wait' utterlog
```

`utterlog --help` prints the short usage summary. There are no export-format, destination, or scope prompts.

## Selection and scope

The picker receives named sessions whose normalized absolute `session_meta.payload.cwd` exactly equals the directory where utterlog was started. A parent, child, or sibling directory is not included. Only current top-level human sessions (`source: cli` or `exec`, `thread_source: user`) in `CODEX_HOME/sessions` are considered; archived and spawned-agent sessions are outside this first version.

Names come from `session_index.jsonl`, joined by `session_meta.payload.id` (which currently agrees with `session_id`). The latest valid name entry is used. Unnamed sessions are omitted and reported; utterlog never invents a name from a prompt.

Discovery filters by directory before validating candidate logs, so unrelated historical formats do not produce warnings. Headers are read with bounded concurrency; sorting reads backwards from each candidate log’s tail instead of loading its full conversation. The full log is read only after selection.

Rows are ordered by the timestamp on the last complete record in each session log, newest first. That order is passed to `fzf` with sorting disabled. fzf searches the name field only and shows the activity time and a unique short session ID, so duplicate names remain distinguishable. Ambient `FZF_DEFAULT_OPTS`, `FZF_DEFAULT_OPTS_FILE`, and `FZF_DEFAULT_COMMAND` are cleared for this invocation.

Press `Esc` or `Ctrl-C` in fzf to cancel without opening an editor; an empty query reports that no session matched. The command refuses noninteractive stdin/stdout rather than waiting indefinitely.

## Transcript and read-only behavior

The selected log is read again after selection and only its complete current-schema `response_item`/`message` records are used. User-authored `user.text` parts and assistant `output_text` in `commentary` or `final_answer` phases remain in log order, including genuine repeated messages. Tool calls, tool output, reasoning, mirrored `item_completed` events, injected context, shell activity, and inter-agent messages are omitted by provenance and record type. Images receive a short placeholder; their payloads are not rendered or OCRed. Markdown headings, code blocks, links, and other message text are not rewritten or truncated.

Each exported message boundary includes its own source timestamp:

```text
## User · 2026-09-12 23:50 · message 1
## Assistant · 2026-09-12 23:51 · message 2
```

Times are local `YYYY-MM-DD HH:mm`; the transcript header states the local IANA timezone once. Missing or invalid source timestamps are shown as `unknown time`, never replaced with the export time.

utterlog writes the transcript to a private temporary directory with a non-writable `0400` snapshot, starts `$EDITOR` and waits for it to exit, then removes only that temporary directory. The Codex session index and logs are never written. This is a read-only viewing contract, not a protection against an editor owner deliberately changing the temporary copy.

`$EDITOR` is parsed as an executable followed by simple quoted or escaped arguments and is started directly; shell substitutions, pipelines, and command strings are not evaluated. GUI editors must be given their own wait flag, for example `EDITOR='code --wait'`.

## Supported storage and failures

The supported input is the current local Codex sessions tree and `session_index.jsonl` schema observed by this tool. There is no app-server connection, network service, archive browser, resume operation, old-schema compatibility layer, or cross-session search.

Missing storage, missing names, an unavailable or failing `fzf`, a missing or failing editor, an unsupported/corrupt selected log, and an empty transcript produce an explanatory error. A malformed complete JSONL record is reported; an unfinished final record from an active writer is ignored so preceding complete records can still be read.

## Development

From this directory:

```sh
bun install
TZ=Asia/Taipei bun run typecheck
TZ=Asia/Taipei bun test
```

The tests create isolated fake Codex homes, a test-owned `fzf` process boundary, and a fake waiting editor. They do not read or modify real Codex state, credentials, installed executables, or services. Keep `.scratch/` planning material out of Git.

See [GLOSSARY.md](GLOSSARY.md) for the tool's terms.
