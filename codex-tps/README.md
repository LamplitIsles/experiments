# Codex response speed

Private Bun/TypeScript workspace library. It reads a trusted, local Codex home;
it has no Grove, HTTP, provider, account or Python/Go runtime dependency.

```ts
import { LogAnalyzer } from "@experiments/codex-tps";

const analyzer = new LogAnalyzer();
const { summary, metrics } = await analyzer.analyze(
  "/test-owned/codex-home",
  { model: "gpt-6-luna", tier: "fast" },
  Date.now(),
);
// summary.hour / fourHours / week: { tps: number | null, samples: number }
// metrics: files discovered, bytes actually read, reused files, elapsedMs
```

Reuse an analyzer to reuse its bounded in-memory file cache. Files with changed
identity, size, mtime or ctime are streamed again in full; this is not an append
index. The cache retains samples at or after the beginning of the seven-day
window; moving the supplied clock backwards reparses files when necessary.
Callers run the library in their own background process and own deadlines and
process disposal. No cache or ledger is written to disk.

Log-estimated output speed is **sum(output tokens) / sum(response seconds)** over
generated samples with reliable usage and timing. Samples may include partial
or interrupted output; they do not measure task success. Output already includes
reasoning. The response window
starts at the latest recorded input or previous usage boundary and ends at the
last generated response item. It includes first-token waiting, excludes gaps
waiting for tool output and users, and is a log estimate, not decoder telemetry.
Parallel responses contribute their individual durations, not machine wall time.
All positive short outputs participate; there is no 100-token cutoff.

The same `now` snapshot bounds inclusive last-generated-item windows of one hour, four
hours and rolling seven days. Exact model ID and recorded tier must match:
`priority`/legacy `fast` map to Fast, explicit `default` to Standard. Missing or
unknown tier is unknown, even when a current configuration would supply a
default. No auth, configuration, SQLite or account material is read. The parser
never infers tokens from text or substitutes full-turn duration.

Active `sessions/` and `archived_sessions/` are included, with stable response
identities deduplicated. New native `token_usage_record` provides response-local
tokens and an ID; deferred/repeated `token_count` is deduplicated by cumulative
output. Older token-count-only records need a generated item, known selection
and reliable task/input boundaries. A native `token_usage_record` records spending,
including incomplete responses; it is not proof of wire completion. No completion
confirmation or whole-turn success filter is applied. Output without usage or
reliable timing, malformed records and unknown formats cannot create samples.
No usable sample returns `null`, not zero. Sample counts are not success counts.
Settings snapshots following a turn context describe that turn; later standalone
settings updates cannot relabel an already running response.

The scanner uses 1 MiB reads with a cooperative yield, ignores symlink entries,
checks canonical containment and opens files read-only with `O_NOFOLLOW`. It
reads a file-size snapshot and defers trailing partial lines. Budgets are 20,000
directory entries, 10,000 files, 32 GiB read per scan, 1 MiB per line and 100,000
window-relevant samples; the file cache retains at most 10,000 files / 100,000 samples. Budget
exhaustion fails the scan; callers retain their previous successful result.
This bounds work rather than promising that every retained history fits a scan.

`bun test --cwd codex-tps` and `bun run --cwd codex-tps typecheck` run in isolation.
Fixtures come from official Codex **0.163.0**, local scripted Responses and an
owned 2.2-second dynamic tool, with environment/configuration noise removed.
The optional reproducible native probe is
`GROVE_CODEX_PATH=/fixed/official/codex bun flickgrove/tests/native-tps.probe.ts`.
It creates and prints a fresh owned root, uses no account or paid provider, and
retains its native artifacts for inspection. It verifies Fast and Standard,
legacy and paginated logs. The additional sanitized `native-incomplete.jsonl`
fixture comes from an already-run owned official probe: one completed 35-token
response followed by a 36-token incomplete response in the same failed turn.
Both generated samples participate: 71 / (0.843 + 0.853) = 41.8632 tok/s,
with the 2.2-second tool wait excluded and usage deduplicated. This verifies the
accepted log estimate, not a strict completion filter. Native catalogues can write inside this owned root;
this is not a zero-write native operation. Library analysis itself is read-only.

Protocol evidence is pinned to official
[Codex 83086188ae0614bd882818ff1aa23f3194962012](https://github.com/openai/codex/tree/83086188ae0614bd882818ff1aa23f3194962012):
[token/turn/settings records](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/protocol/src/protocol.rs),
[rollout persistence](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/rollout/src/policy.rs),
[response processing](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/turn.rs).
Runtime evidence and measured host costs are in spec #4518's implementation
report; research #4517 was documentation/source inspection only.

The response-window rule was informed by MIT
[adenta/codex-tps be549617f50409c8c0e15a8a6838520ec12d2bb1](https://github.com/adenta/codex-tps/tree/be549617f50409c8c0e15a8a6838520ec12d2bb1).
This is an independent TypeScript implementation; its reference license is
preserved in [licenses/codex-tps-MIT.txt](licenses/codex-tps-MIT.txt).
No code was copied from the unlicensed `codex_speed.py` Gist.
