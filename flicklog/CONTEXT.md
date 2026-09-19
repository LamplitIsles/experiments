# FlickLog context

## Terms

### FlickLog record

A searchable semantic-history record indexed from a supported agent session. In v0, `kind: message` covers Codex `user` messages and user-facing assistant `commentary` / `final_answer` messages. `kind: compaction` covers only a non-empty plaintext `compacted.payload.message` checkpoint. Tool calls, `replacement_history`, and reasoning/thinking are not FlickLog records.

### Ingest

Incrementally project every supported local source into the Meilisearch projection. In v0, Codex is the sole supported source, so `flicklog ingest` has no source selector. `search` runs the same configure-then-ingest path before querying; interactive terminals show session-log progress only when logs are pending, while non-interactive stdout remains one final JSON value.

### Session

One top-level Codex user session. Its identity comes from Codex `session_meta.payload.id`.

### Working directory

The absolute `session_meta.payload.cwd` recorded by Codex for a session. In v0 this is the project scope; FlickLog does not infer a repository root or other project identity.

### Device

One machine ingesting Codex history into the shared Meilisearch instance.

### Device ID

The scope used to isolate one device's indexed data inside the shared Meilisearch index. In v0 the device ID is derived from the machine hostname. The domain concept is `deviceId`, not hostname, so the identifier strategy may change later without changing the model.

### Source record

The original record in a Codex JSONL session log from which a FlickLog record was derived. FlickLog records the source JSONL path and original JSONL record index as provenance so a result can be traced back to its source.

### Storage identity

Normal messages retain Codex `payload.id` as `sourceId`, but use `sha256(deviceId + sourceId)` as their FlickLog storage ID. A normal message with no usable source ID and every compaction use `sha256(deviceId + sourcePath + sourceRecordIndex)` instead. Compactions have no `sourceId`.

### Search scope

Search defaults to the CLI process's exact normalized working directory on the current device. The caller does not normally provide cwd as an argument; cross-project search is explicitly requested with `--all-projects`.

### Search ranking

FlickLog ranks exact textual matches before recency. Numeric query tokens match exact numbers only; `createdAt:desc` is the deterministic tie-breaker when textual relevance is otherwise equal.

### Context expansion

Context expansion starts from one indexed record and reads its surrounding records from the original Codex JSONL. `flicklog context <record-id>` returns eligible natural-language messages and plaintext compactions only; `--include-tools` explicitly adds supported nearby tool calls/results. The selected record and nearest eligible source-record neighbourhood share one 12,000-character budget. Clipped content keeps balanced Unicode-safe head and tail text around an `…<N> chars truncated…` marker, and the response reports truncation. Tool activity remains source data, not indexed FlickLog messages.

## v0 boundaries

- Bun + TypeScript, consistent with the experiments repository and utterlog.
- Codex only.
- Natural-language user and assistant messages, plus non-empty plaintext compaction checkpoints.
- Assistant `commentary` and `final_answer` remain separate messages.
- No tool-call indexing; `flicklog context <record-id> --include-tools` may return supported source tool calls/results within its global budget.
- No reasoning/thinking indexing.
- No SQLite canonical store.
- Codex JSONL remains the source of truth.
- Meilisearch is a derived searchable projection.
- A single shared Meilisearch index is partitioned by `deviceId`.
- Source deletion reconciliation is deferred; v0 does not remove indexed documents when a JSONL source disappears.
