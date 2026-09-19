# flicklog

FlickLog is a Bun/TypeScript CLI that makes local Codex session history searchable. Codex JSONL remains the source of truth; Meilisearch is a rebuildable local projection. This v0 does not reconcile source deletion, so documents from a removed source log remain until a future rebuild feature exists.

## Install and setup

FlickLog requires Bun 1.3+ and macOS with Homebrew Meilisearch installed. From this checkout:

```sh
cd flicklog
bun install --frozen-lockfile
bun add --global "$PWD"
export PATH="$(bun pm bin -g):$PATH"
flicklog setup
```

`setup` creates `~/.flicklog` with a private master-key file, Meilisearch data/configuration, and the `~/Library/LaunchAgents/dev.flicklog.meilisearch.plist` LaunchAgent. It binds only to `127.0.0.1:7701`, never calls `brew services`, and therefore does not alter a generic Homebrew Meilisearch service. It starts/reloads only FlickLog’s agent and waits for health and index settings.

## Use

From a project directory with Codex history:

```sh
flicklog search "Chinese keyword 或 code identifier"
flicklog search "release decision" --all-projects
flicklog context <message-id>
```

Every successful command writes one JSON object to stdout. Warnings/errors go to stderr and failures return non-zero. `search` incrementally scans first: it checkpoints complete JSONL byte offsets and original source record ordinals, skips unchanged files, and reads only appended bytes for grown files. Search defaults to this machine’s hostname-derived `deviceId` and the exact normalized current working directory. `--all-projects` removes only cwd filtering; device isolation remains.

Only Codex top-level user messages and assistant `commentary`/`final_answer` messages are indexed. Commentary and final answers are separate documents. Tool activity, reasoning/thinking, developer/system text, injected provenance, and spawned sessions are never indexed.

`context` resolves an indexed hit to its original JSONL path/record and returns nearby source items in order. It includes tool calls/results by default but never reasoning; large tool payloads are truncated with `truncated: true`. Tools are context-only, not searchable.

## Environment

- `CODEX_HOME` — source Codex home (default `~/.codex`); useful for isolated testing.
- `FLICKLOG_STATE_DIR` — FlickLog-owned local state (default `~/.flicklog`).
- `FLICKLOG_CONTEXT_INCLUDE_TOOLS=false` or `0` — omit tool items from context.
- `FLICKLOG_MEILI_URL` and `FLICKLOG_MEILI_KEY` — use an external Meilisearch instance; `setup` then does not manage a LaunchAgent.
- `FLICKLOG_MEILI_PORT` — local dedicated port (default `7701`).

Meilisearch 1.53.x’s ordinary language-neutral `content` field is used for Chinese/English/code mixed text; FlickLog does not force a Chinese tokenizer or locale hint.

## Development

```sh
bun run typecheck
bun run test
```

Tests create isolated fake Codex homes and state directories. They do not read real history, credentials, installed service state, or launch agents.
