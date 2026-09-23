# flicklog

FlickLog is a Bun/TypeScript CLI that makes local Codex session history searchable. Codex JSONL remains the source of truth; Meilisearch is a rebuildable local projection. This v0 does not reconcile source deletion, so documents from a removed source log remain until a future rebuild feature exists.

## Install and setup

FlickLog requires Bun 1.3+ and macOS with Homebrew Meilisearch installed. From this checkout:

```sh
cd /absolute/path/to/experiments
bun install --frozen-lockfile
cd flicklog
bun add --global "$PWD"
export PATH="$(bun pm bin -g):$PATH"
flicklog setup
```

`setup` creates `~/.flicklog` with a private master-key file, Meilisearch data/configuration, and the `~/Library/LaunchAgents/dev.flicklog.meilisearch.plist` LaunchAgent. The agent runs with that state directory as its working directory, binds only to `127.0.0.1:7701`, never calls `brew services`, and therefore does not alter a generic Homebrew Meilisearch service. It starts/reloads only FlickLog’s agent and waits for health and index settings.

## Use

From a project directory with Codex history:

```sh
flicklog search "Chinese keyword 或 code identifier" # five cards by default
flicklog ingest
flicklog search "release decision" --all-projects
flicklog search "release decision" --limit 12
flicklog search "timeout" --since 2d
flicklog search "timeout" --from "2026-01-05T00:00:00Z"
flicklog search "timeout" --from "2026-01-05T00:00:00Z" --until "2026-01-06T00:00:00Z"
flicklog get <record-id>
flicklog context <record-id>
flicklog context <record-id> --include-tools
```

Every successful command writes one JSON object to stdout. Warnings/errors go to stderr and failures return non-zero. `ingest` incrementally projects every supported local source (Codex only in v0) into Meilisearch; it has no source selector. `search` runs that same ingest first: it checkpoints complete JSONL byte offsets and original source record ordinals, skips unchanged files, and reads only appended bytes for grown files. In an interactive terminal, `ingest` and a `search` with pending session JSONL logs render progress on stderr by session log, with a retained completion summary. Non-interactive runs render no progress, leaving stdout as one final JSON object. Search defaults to this machine’s hostname-derived `deviceId` and the exact normalized current working directory. `--all-projects` removes only cwd filtering; device isolation remains.

FlickLog indexes two kinds of semantic history: Codex top-level user messages and assistant `commentary`/`final_answer` messages (`kind: "message"`), plus non-empty Codex `compacted.payload.message` checkpoints (`kind: "compaction"`). Commentary and final answers are separate documents. Compaction indexes only its plaintext message, never `replacement_history`, and has no fabricated user/assistant role. Tool activity, reasoning/thinking, developer/system text, injected provenance, and spawned sessions are never indexed.

`search` returns five compact cards by default; `--limit <1-20>` deliberately requests a different bounded count. Results rank exact textual matches before recency; numeric query tokens require an exact match, and recency breaks remaining ties. Each card has a stable record ID and a Meilisearch-highlighted, query-centred snippet; it never returns full record content or source provenance. Use `get <record-id>` to expand exactly one selected same-device record in full.

An optional time window further narrows search scope before Meilisearch runs the textual query and ranking; it is never a post-search result filter. `--since <positive-integer><s|m|h|d|w>` uses `[now - duration, now)`, so `--since 2d` searches the preceding two days. Absolute timestamps must be RFC3339: `--from <timestamp>` uses `[from, +∞)`, and adding `--until <timestamp>` uses `[from, until)`. Bounds are evaluated at Unix-second precision. `--since` cannot be combined with `--from` or `--until`; `--until` requires `--from`; repeated time flags, non-positive or invalid durations, invalid timestamps, and a `from` that is not earlier than `until` fail before ingest begins. A time window combines with the current-device and current-working-directory scope. `--all-projects` removes only the working-directory portion of that scope.

After upgrading an existing FlickLog installation for time-window search, run the one-off local projection backfill once before using time bounds:

```sh
cd /absolute/path/to/experiments/flicklog
bun scripts/backfill-created-at-epoch.ts
```

It uses the same `FLICKLOG_MEILI_URL`, `FLICKLOG_MEILI_KEY`, `FLICKLOG_STATE_DIR`, and `FLICKLOG_MEILI_PORT` conventions as FlickLog itself. The script pages existing documents, partially updates valid historical `createdAt` values with `createdAtEpoch`, and reports `scanned`, `updated`, and `skipped` counts. It is safe to run again; it is not a normal `flicklog` command or a general migration system.

`context <record-id>` resolves a selected same-device record to its original JSONL and returns up to eight eligible context items before it, the selected item, and up to eight after it, in source order. The response's `targetSourceRecordIndex` identifies the selected item among `items` by its `sourceRecordIndex`, even when messages have identical text. By default eligible items are natural-language messages and plaintext compactions, never reasoning; intervening tool activity does not use up the eight-item quota. `--include-tools` deliberately adds supported tool calls/results to both the returned items and that quota. All returned item content shares one 12,000-character budget, so fewer items may be returned when content is long; clipped items keep balanced Unicode-safe head and tail text around an omission-count marker such as `…42 chars truncated…`, and the response reports `truncated: true`. Tools are context-only, not searchable.

## Environment

- `CODEX_HOME` — source Codex home (default `~/.codex`); useful for isolated testing.
- `FLICKLOG_STATE_DIR` — FlickLog-owned local state (default `~/.flicklog`).
- `FLICKLOG_MEILI_URL` and `FLICKLOG_MEILI_KEY` — use an external Meilisearch instance; `setup` then does not manage a LaunchAgent.
- `FLICKLOG_MEILI_PORT` — local dedicated port (default `7701`).

Meilisearch 1.53.x’s ordinary language-neutral `content` field is used for Chinese/English/code mixed text; FlickLog does not force a Chinese tokenizer or locale hint.

## Development

```sh
cd /absolute/path/to/experiments
bun install --frozen-lockfile
cd flicklog
bun run typecheck
bun run test
```

Tests create isolated fake Codex homes and state directories. They do not read real history, credentials, installed service state, or launch agents.
