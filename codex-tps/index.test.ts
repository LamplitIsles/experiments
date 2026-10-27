import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogAnalyzer, ResponseParser, summarize, tier } from "./index";

const selection = { model: "gpt-6-luna", tier: "fast" as const };
async function native(mode: string) {
  return (
    await Bun.file(
      new URL(`./fixtures/native-priority-${mode}.jsonl`, import.meta.url),
    ).text()
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
test("actual 0.163 legacy and paginated completions exclude owned 2.2s tool, include first-token wait, and count output once", async () => {
  const samples = [];
  for (const mode of ["paginated", "legacy"]) {
    const parser = new ResponseParser();
    const rows = await native(mode);
    for (const row of rows) parser.push(row);
    expect(parser.samples).toHaveLength(2);
    for (const s of parser.samples) {
      expect(s.seconds).toBeGreaterThan(0.8); // 350ms pre-created + 250ms pre-item + 200ms generation.
      expect(s.seconds).toBeLessThan(1.2); // 2.2s owned tool is not sampling time.
    }
    samples.push(...parser.samples);
  }
  const now = Date.parse("2026-10-23T15:36:51.000Z");
  expect(summarize(samples, selection, now).hour).toEqual({
    tps: 130 / 3.407,
    samples: 4,
  });
  expect(
    summarize(samples, { ...selection, tier: "standard" }, now).week.tps,
  ).toBeNull();
  expect(
    summarize(samples, { ...selection, model: "other" }, now).week.samples,
  ).toBe(0);
});

const now = Date.parse("2026-10-23T12:00:00Z");
function row(type: string, payload: any, ms: number) {
  return { timestamp: new Date(now + ms).toISOString(), type, payload };
}
function cycle(
  id: string,
  start: number,
  model = "model",
  speed: unknown = "default",
  output = 2,
  duration = 1000,
) {
  return [
    row("session_meta", { id: "owned" }, start),
    row("event_msg", { type: "task_started", turn_id: id }, start),
    row("turn_context", { turn_id: id, model }, start),
    row(
      "event_msg",
      {
        type: "thread_settings_applied",
        thread_id: "owned",
        thread_settings: { model, service_tier: speed },
      },
      start,
    ),
    row("response_item", { type: "message", role: "user", content: [] }, start),
    row(
      "response_item",
      { type: "message", role: "assistant", content: [] },
      start + duration,
    ),
    row(
      "event_msg",
      {
        type: "token_count",
        info: {
          last_token_usage: {
            output_tokens: output,
            reasoning_output_tokens: 1,
          },
          total_token_usage: { output_tokens: output },
        },
      },
      start + duration + 100,
    ),
    row("event_msg", { type: "task_complete" }, start + duration + 200),
  ];
}
test("boundaries are inclusive, concurrent responses weighted, positive short outputs retained", () => {
  const sample = (
    id: string,
    generatedAt: number,
    output = 2,
    seconds = 1,
  ) => ({
    id,
    generatedAt,
    model: "model",
    tier: "standard" as const,
    seconds,
    output,
  });
  const values = [
    sample("one", now - 3600000),
    sample("four", now - 14400000),
    sample("week", now - 604800000),
    sample("now", now, 10, 2),
    sample("future", now + 1),
    sample("old", now - 604800001),
  ];
  expect(summarize(values, { model: "model", tier: "standard" }, now)).toEqual({
    hour: { tps: 4, samples: 2 },
    fourHours: { tps: 3.5, samples: 3 },
    week: { tps: 3.2, samples: 4 },
  });
});
test("native repeated response IDs and later settings updates cannot duplicate or relabel an in-flight response", async () => {
  const parser = new ResponseParser();
  for (const r of await native("paginated")) {
    if (r.type === "response_item" && r.payload.type === "function_call") {
      parser.push(
        row(
          "event_msg",
          {
            type: "thread_settings_applied",
            thread_settings: { model: "other", service_tier: "default" },
          },
          0,
        ),
      );
    }
    parser.push(r);
    if (r.type === "token_usage_record") parser.push(r);
  }
  expect(parser.samples.map((s) => [s.model, s.tier, s.output])).toEqual([
    ["gpt-6-luna", "fast", 31],
    ["gpt-6-luna", "fast", 32],
  ]);
});
test("cumulative and repeated usage, model/tier changes, missing tier, missing usage/invalid duration", () => {
  const parser = new ResponseParser();
  const first = cycle("a", -2000);
  first.splice(7, 0, first[6]);
  for (const r of first) parser.push(r);
  // Totals are thread cumulative; last usage is response-local.
  const second = cycle("b", 0, "different", "priority", 1);
  second[6].payload.info.total_token_usage.output_tokens = 3;
  for (const r of second) parser.push(r);
  for (const r of cycle("c", 2000, "model", null, 4)) parser.push(r);
  for (const r of cycle("d", 4000, "model", "unknown", 6)) parser.push(r);
  for (const r of cycle("e", 6000, "model", "default", 8, 0)) parser.push(r);
  for (const r of cycle("f", 8000, "model", "default", 10).slice(0, 6))
    parser.push(r);
  expect(parser.samples.map((s) => [s.model, s.tier, s.output])).toEqual([
    ["model", "standard", 2],
    ["different", "fast", 1],
  ]);
  expect([
    tier("priority"),
    tier("fast"),
    tier("default"),
    tier(null),
    tier("flex"),
  ]).toEqual(["fast", "fast", "standard", null, null]);
});
test("streaming read-only scanner reuses unmodified files, deduplicates archive, skips symlinks and partial/malformed lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tps-"));
  try {
    await mkdir(join(root, "sessions"));
    await mkdir(join(root, "archived_sessions"));
    const path = join(root, "sessions", "owned.jsonl");
    const data =
      (await native("paginated")).map((r) => JSON.stringify(r)).join("\n") +
      "\n";
    await writeFile(path, data);
    await writeFile(join(root, "archived_sessions", "copy.jsonl"), data);
    await symlink(path, join(root, "sessions", "link.jsonl"));
    const analyzer = new LogAnalyzer();
    const clock = Date.parse("2026-10-23T15:36:51Z");
    const cold = await analyzer.analyze(root, selection, clock);
    expect(cold.summary.hour.samples).toBe(2);
    expect(cold.metrics.files).toBe(2);
    expect(cold.metrics.bytes).toBe(Buffer.byteLength(data) * 2);
    const hot = await analyzer.analyze(root, selection, clock);
    expect(hot.metrics.bytes).toBe(0);
    expect(hot.metrics.reused).toBe(2);
    expect(await readFile(path, "utf8")).toBe(data);
    await writeFile(
      path,
      data + "{malformed}\nnull\n" + JSON.stringify(cycle("partial", 0)[0]),
    );
    const changed = await analyzer.analyze(root, selection, clock);
    expect(changed.summary.hour).toEqual(cold.summary.hour);
    expect(changed.metrics.reused).toBe(1);
    expect(changed.metrics.bytes).toBeGreaterThan(Buffer.byteLength(data));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("old history does not exhaust the sample budget for a recent matching response", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tps-old-history-"));
  try {
    await mkdir(join(root, "sessions"));
    const oldStart = -8 * 24 * 60 * 60 * 1000;
    const rows = cycle("old", oldStart)
      .slice(0, 4)
      .map((item) => JSON.stringify(item));
    for (let i = 0; i <= 100000; i++) {
      rows.push(
        JSON.stringify(
          row(
            "response_item",
            { type: "message", role: "assistant" },
            oldStart + i * 2 + 1,
          ),
        ),
      );
      rows.push(
        JSON.stringify(
          row(
            "event_msg",
            {
              type: "token_count",
              info: {
                last_token_usage: { output_tokens: 1 },
                total_token_usage: { output_tokens: i + 1 },
              },
            },
            oldStart + i * 2 + 2,
          ),
        ),
      );
    }
    const recent = cycle("recent", -2000);
    recent[6].payload.info.total_token_usage.output_tokens = 100002;
    rows.push(...recent.map((item) => JSON.stringify(item)));
    await writeFile(
      join(root, "sessions", "history.jsonl"),
      rows.join("\n") + "\n",
    );
    const result = await new LogAnalyzer().analyze(
      root,
      { model: "model", tier: "standard" },
      now,
    );
    expect(result.summary.hour).toEqual({ tps: 2, samples: 1 });
    expect(result.summary.week.samples).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("moving the clock backwards reparses cached history needed by the earlier window", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tps-clock-"));
  try {
    await mkdir(join(root, "sessions"));
    const old = cycle("old", -9 * 24 * 60 * 60 * 1000);
    const recent = cycle("recent", -2000);
    recent[6].payload.info.total_token_usage.output_tokens = 4;
    await writeFile(
      join(root, "sessions", "history.jsonl"),
      [...old, ...recent].map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const analyzer = new LogAnalyzer();
    const selected = { model: "model", tier: "standard" as const };
    expect(
      (await analyzer.analyze(root, selected, now)).summary.week.samples,
    ).toBe(1);
    const earlier = await analyzer.analyze(
      root,
      selected,
      now - 3 * 24 * 60 * 60 * 1000,
    );
    expect(earlier.summary.week.samples).toBe(1);
    expect(earlier.metrics.bytes).toBeGreaterThan(0);
    expect(
      (await analyzer.analyze(root, selected, now)).summary.hour.samples,
    ).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained history larger than the old cache does not reread unchanged files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tps-cache-"));
  try {
    await mkdir(join(root, "sessions"));
    const data =
      (await native("paginated"))
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n";
    for (let i = 0; i < 257; i++)
      await writeFile(join(root, "sessions", `${i}.jsonl`), data);
    const analyzer = new LogAnalyzer();
    const clock = Date.parse("2026-10-23T15:36:51Z");
    const cold = await analyzer.analyze(root, selection, clock);
    const hot = await analyzer.analyze(root, selection, clock);
    expect(hot.summary).toEqual(cold.summary);
    expect(hot.metrics.bytes).toBe(0);
    expect(hot.metrics.reused).toBe(257);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned native completed35 + incomplete36 are two log-estimate samples, with response/cumulative/archive deduplication", async () => {
  const data = await Bun.file(
    new URL("./fixtures/native-incomplete.jsonl", import.meta.url),
  ).text();
  const rows = data
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const parser = new ResponseParser();
  for (const r of rows) {
    parser.push(r);
    if (r.type === "token_usage_record" || r.payload.type === "token_count")
      parser.push(r);
  }
  expect(
    parser.samples.map((s) => [s.output, s.seconds, s.model, s.tier]),
  ).toEqual([
    [35, 0.843, "gpt-6-luna", "fast"],
    [36, 0.853, "gpt-6-luna", "fast"],
  ]);
  const clock = Date.parse("2026-10-23T16:19:00Z");
  const expected = { tps: 71 / 1.696, samples: 2 };
  expect(summarize(parser.samples, selection, clock)).toEqual({
    hour: expected,
    fourHours: expected,
    week: expected,
  });
  const root = await mkdtemp(join(tmpdir(), "codex-tps-partial-"));
  try {
    await mkdir(join(root, "sessions"));
    await mkdir(join(root, "archived_sessions"));
    const active = join(root, "sessions", "native.jsonl");
    await writeFile(active, data);
    await writeFile(join(root, "archived_sessions", "copy.jsonl"), data);
    const analyzer = new LogAnalyzer();
    const result = await analyzer.analyze(root, selection, clock);
    expect(result.summary.hour).toEqual(expected);
    expect(result.metrics.files).toBe(2);
    expect((await analyzer.analyze(root, selection, clock)).metrics.bytes).toBe(
      0,
    );
    expect(
      (await analyzer.analyze(root, { ...selection, tier: "standard" }, clock))
        .summary.hour,
    ).toEqual({ tps: null, samples: 0 });
    expect(await readFile(active, "utf8")).toBe(data);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
