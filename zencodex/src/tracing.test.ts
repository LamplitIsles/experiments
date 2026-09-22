import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExporter, PerformanceTrace, traceEvents } from "./tracing";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";

test("Bun preserves isolated async OTel parent context and exports OTLP JSON", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const contexts = new AsyncLocalStorageContextManager().enable();
  const tracer = provider.getTracer("zencodex-test");
  try {
    await Promise.all(
      ["startup", "session.load"].map(async (name) => {
        const parent = tracer.startSpan(name, {}, ROOT_CONTEXT);
        try {
          await contexts.with(trace.setSpan(ROOT_CONTEXT, parent), async () => {
            await Bun.sleep(1);
            const child = tracer.startSpan(
              `${name}.child`,
              {},
              contexts.active(),
            );
            await Bun.sleep(1);
            child.end();
          });
        } finally {
          parent.end();
        }
      }),
    );
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    for (const name of ["startup", "session.load"]) {
      const parent = spans.find((span) => span.name === name)!;
      const child = spans.find((span) => span.name === `${name}.child`)!;
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    }
    const bytes = JsonTraceSerializer.serializeRequest(spans)!;
    const otlp = JSON.parse(new TextDecoder().decode(bytes));
    const exported = otlp.resourceSpans.flatMap((resource: any) =>
      resource.scopeSpans.flatMap((scope: any) => scope.spans),
    );
    expect(exported).toHaveLength(4);
    expect(exported[0].traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(BigInt(exported[0].endTimeUnixNano)).toBeGreaterThan(
      BigInt(exported[0].startTimeUnixNano),
    );
  } finally {
    contexts.disable();
    await provider.shutdown();
  }
});

test("application traces flush to private OTLP batches and convert to offline waterfall events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zencodex-trace-"));
  const performance = new PerformanceTrace(fileExporter(directory));
  try {
    await performance.measure("session.load", async () => {
      await performance.measure("history.page", async (span) => {
        span.setAttribute("turns", 20);
        await Bun.sleep(1);
      });
    });
    await expect(
      performance.measure("failed.stage", () => {
        throw new Error("SECRET prompt path");
      }),
    ).rejects.toThrow();
    await performance.close();
    const files = await readdir(directory);
    expect(files.length).toBeGreaterThan(0);
    const text = await readFile(join(directory, files[0]), "utf8");
    expect(text).toContain("resourceSpans");
    expect(text).not.toContain("SECRET");
    const events = (await traceEvents(directory)).traceEvents.filter(
      (event) => event.ph === "X",
    );
    expect(events.map((event) => event.name).sort()).toEqual([
      "failed.stage",
      "history.page",
      "session.load",
    ]);
    const child = events.find((event) => event.name === "history.page")!;
    const parent = events.find((event) => event.name === "session.load")!;
    expect(child.pid).toBe(parent.pid);
    expect(child.tid).not.toBe(parent.tid);
    expect(child.args.parentSpanId).toBe(parent.args.spanId);
    expect(child.ts).toBeGreaterThanOrEqual(parent.ts);
    expect(
      events.find((event) => event.name === "failed.stage")!.args.status.code,
    ).toBe(2);
  } finally {
    await performance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trace retention only prunes owned batch files and failed export is contained", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zencodex-trace-retention-"));
  try {
    await writeFile(join(directory, "keep.txt"), "untouched");
    for (let i = 0; i < 34; i++)
      await writeFile(join(directory, `trace-${1000 + i}-aaaa.json`), "{}");
    const exporter = fileExporter(directory);
    const result = await new Promise<any>((resolve) =>
      exporter.export([], resolve),
    );
    expect(result.code).toBe(0);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(32);
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe(
      "untouched",
    );
    const broken = fileExporter(join(directory, "keep.txt", "child"));
    expect(
      (await new Promise<any>((resolve) => broken.export([], resolve))).code,
    ).toBe(1);
    await broken.shutdown();
    await exporter.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("focused traces name their tracks and separate concurrent spans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zencodex-trace-view-"));
  try {
    const span = (
      spanId: string,
      name: string,
      start: number,
      end: number,
      parentSpanId?: string,
    ) => ({
      traceId: "1234567890abcdef1234567890abcdef",
      spanId,
      name,
      parentSpanId,
      startTimeUnixNano: String(start * 1000),
      endTimeUnixNano: String(end * 1000),
    });
    await writeFile(
      join(directory, "trace-1000-aaaa.json"),
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  span(
                    "0000000000000002",
                    "connect",
                    2000,
                    6000,
                    "0000000000000001",
                  ),
                  span(
                    "0000000000000003",
                    "reader.shell",
                    3000,
                    8000,
                    "0000000000000001",
                  ),
                  span("0000000000000001", "session.load", 1000, 10000),
                  span(
                    "0000000000000004",
                    "later.callback",
                    50000,
                    60000,
                    "0000000000000001",
                  ),
                ],
              },
            ],
          },
        ],
      }),
    );
    const { traceEvents: events } = await traceEvents(
      directory,
      "session.load",
    );
    const slices = events.filter((event) => event.ph === "X");
    expect(slices.map((event) => event.name)).toEqual([
      "session.load",
      "connect",
      "reader.shell",
    ]);
    expect(slices[1].tid).not.toBe(slices[2].tid);
    expect(slices.every((event) => event.tid > event.pid)).toBe(true);
    expect(
      events.find((event) => event.name === "process_name")?.args.name,
    ).toContain("session.load");
    expect(events.some((event) => event.name === "thread_name")).toBe(true);
    await expect(traceEvents(directory, "missing.operation")).rejects.toThrow(
      "No recorded operation",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
