# FlickLog context

## Terms

### FlickLog record
A searchable semantic-history record indexed from a supported agent session. In v0, `kind: message` covers Codex `user` messages and user-facing assistant `commentary` / `final_answer` messages. `kind: compaction` covers only a non-empty plaintext `compacted.payload.message` checkpoint. Tool calls, `replacement_history`, and reasoning/thinking are not FlickLog records.

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

### Search scope
Search defaults to the CLI process's exact normalized working directory on the current device. The caller does not normally provide cwd as an argument; cross-project search is explicitly requested with `--all-projects`.

### Context expansion
Context expansion starts from one indexed message and reads surrounding records from the original Codex JSONL. Search indexes only natural-language messages, but the CLI context command may expose nearby tool calls/results when `FLICKLOG_CONTEXT_INCLUDE_TOOLS` is enabled (the default). Tool activity remains source data, not indexed FlickLog messages.

## v0 boundaries

- Bun + TypeScript, consistent with the experiments repository and utterlog.
- Codex only.
- Natural-language user and assistant messages, plus non-empty plaintext compaction checkpoints.
- Assistant `commentary` and `final_answer` remain separate messages.
- No tool-call indexing; `flicklog context` may return source tool calls/results on demand according to environment configuration.
- No reasoning/thinking indexing.
- No SQLite canonical store.
- Codex JSONL remains the source of truth.
- Meilisearch is a derived searchable projection.
- A single shared Meilisearch index is partitioned by `deviceId`.
- Source deletion reconciliation is deferred; v0 does not remove indexed documents when a JSONL source disappears.
