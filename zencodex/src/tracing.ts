import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BatchSpanProcessor,
  TracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";

const batchName = /^trace-\d+-[a-f0-9-]+\.json$/;
export const defaultTraceDirectory = () =>
  join(homedir(), ".local", "state", "zencodex", "traces");

/** Each atomic OTLP batch is independently readable; retention never follows user filenames. */
export function fileExporter(directory: string): SpanExporter {
  let pending = Promise.resolve();
  let queuedBatches = 0;
  return {
    export(spans, callback) {
      if (queuedBatches >= 4) {
        callback({ code: 1 });
        return;
      }
      queuedBatches++;
      pending = pending
        .then(async () => {
          const bytes = JsonTraceSerializer.serializeRequest(spans);
          if (!bytes || bytes.length > 1024 * 1024)
            throw new Error("trace batch limit");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const name = `trace-${Date.now()}-${crypto.randomUUID()}.json`;
          const temporary = join(directory, `${name}.tmp`);
          try {
            await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
            await rename(temporary, join(directory, name));
          } finally {
            await unlink(temporary).catch(() => {});
          }
          const entries = await readdir(directory);
          for (const entry of entries) {
            const match = /^trace-(\d+)-[a-f0-9-]+\.json\.tmp$/.exec(entry);
            if (match && Number(match[1]) < Date.now() - 86_400_000)
              await unlink(join(directory, entry)).catch(() => {});
          }
          const files = entries.filter((name) => batchName.test(name)).sort();
          await Promise.all(
            files
              .slice(0, Math.max(0, files.length - 32))
              .map((name) => unlink(join(directory, name)).catch(() => {})),
          );
        })
        .then(
          () => {
            queuedBatches--;
            callback({ code: 0 });
          },
          () => {
            queuedBatches--;
            callback({ code: 1 });
          },
        );
    },
    async shutdown() {
      await pending;
    },
    async forceFlush() {
      await pending;
    },
  };
}

export class PerformanceTrace {
  private readonly runId = crypto.randomUUID();
  private readonly contexts = new AsyncLocalStorageContextManager().enable();
  private readonly provider: TracerProvider;
  private readonly tracer;
  constructor(exporter: SpanExporter) {
    this.provider = new TracerProvider({
      spanProcessors: [
        new BatchSpanProcessor({
          exporter,
          maxQueueSize: 256,
          maxExportBatchSize: 64,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: 1500,
        }),
      ],
    });
    this.tracer = this.provider.getTracer("zencodex", "0.1.0");
  }
  begin(name: string, attributes: Attributes = {}, startTime?: number) {
    const span = this.tracer.startSpan(
      name,
      {
        attributes: {
          "process.run_id": this.runId,
          "schema.version": 1,
          "runtime.version": Bun.version,
          ...attributes,
        },
        startTime,
      },
      this.contexts.active(),
    );
    let ended = false;
    return {
      span,
      run: <T>(fn: () => T): T =>
        this.contexts.with(trace.setSpan(this.contexts.active(), span), fn),
      end: (outcome: "ok" | "error" | "cancel" = "ok") => {
        if (ended) return;
        ended = true;
        span.setAttribute("outcome", outcome);
        span.setStatus({
          code: outcome === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.end();
      },
    };
  }
  async measure<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    attributes: Attributes = {},
  ): Promise<T> {
    const operation = this.begin(name, attributes);
    try {
      return await operation.run(() => fn(operation.span));
    } catch (error) {
      operation.end("error");
      throw error;
    } finally {
      operation.end();
    }
  }
  async close() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.provider.shutdown(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } catch {
      /* tracing never blocks application cleanup */
    } finally {
      if (timer) clearTimeout(timer);
      this.contexts.disable();
    }
  }
}

export const noTrace = {
  begin: (
    _name: string,
    _attributes: Attributes = {},
    _startTime?: number,
  ) => ({
    span: trace.wrapSpanContext(INVALID_SPAN_CONTEXT),
    run: <T>(fn: () => T) => fn(),
    end: (_outcome?: "ok" | "error" | "cancel") => {},
  }),
  measure: async <T>(
    _name: string,
    fn: (span: Span) => Promise<T> | T,
    _attributes: Attributes = {},
  ) => fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT)),
  close: async () => {},
};
export type Trace = Pick<PerformanceTrace, "begin" | "measure" | "close">;

/** Offline conversion for Perfetto's Chrome JSON importer; no server or upload. */
export async function traceEvents(directory: string, operation?: string) {
  const files = (await readdir(directory))
    .filter((name) => batchName.test(name))
    .sort();
  let spans: any[] = [];
  for (const name of files) {
    const data = JSON.parse(await readFile(join(directory, name), "utf8"));
    for (const resource of data.resourceSpans ?? [])
      for (const scope of resource.scopeSpans ?? [])
        spans.push(...(scope.spans ?? []));
  }
  if (operation) {
    const root = spans
      .filter((span) => span.name === operation)
      .sort((a, b) =>
        Number(BigInt(b.startTimeUnixNano) - BigInt(a.startTimeUnixNano)),
      )[0];
    if (!root) throw new Error(`No recorded operation: ${operation}`);
    // Focus on one completed operation, not later callbacks sharing its context.
    spans = spans.filter(
      (span) =>
        span.traceId === root.traceId &&
        BigInt(span.startTimeUnixNano) >= BigInt(root.startTimeUnixNano) &&
        BigInt(span.endTimeUnixNano) <= BigInt(root.endTimeUnixNano),
    );
  }
  spans.sort((a, b) =>
    Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)),
  );
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const processes = new Map(
    [...new Set(spans.map((span) => span.traceId))].map((id, i) => [id, i + 1]),
  );
  const metadata: any[] = [];
  const lanes = new Map<string, Array<{ tid: number; end: bigint }>>();
  // Chrome import treats tid=0 as the process/main thread. Keep all synthetic
  // thread IDs positive and distinct from process IDs and each other.
  let nextTid = processes.size + 1;
  for (const [id, pid] of processes) {
    const root = spans.find(
      (span) => span.traceId === id && !byId.has(span.parentSpanId),
    )!;
    const ms =
      Number(BigInt(root.endTimeUnixNano) - BigInt(root.startTimeUnixNano)) /
      1e6;
    metadata.push({
      ph: "M",
      name: "process_name",
      pid,
      args: { name: `${root.name} · ${ms.toFixed(1)} ms` },
    });
  }
  const events = spans.map((span) => {
    let depth = 0,
      parent = span.parentSpanId;
    const seen = new Set<string>();
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      depth++;
      parent = byId.get(parent).parentSpanId;
    }
    const pid = processes.get(span.traceId)!;
    const start = BigInt(span.startTimeUnixNano);
    const key = `${pid}:${depth}`;
    const tracks = lanes.get(key) ?? [];
    let lane = tracks.find((track) => track.end <= start);
    if (!lane) {
      const tid = nextTid++;
      lane = { tid, end: 0n };
      metadata.push({
        ph: "M",
        name: "thread_name",
        pid,
        tid,
        args: {
          name:
            depth === 0
              ? "Operation"
              : `Stages ${depth}${tracks.length ? ` · parallel ${tracks.length + 1}` : ""}`,
        },
      });
      metadata.push({
        ph: "M",
        name: "thread_sort_index",
        pid,
        tid,
        args: { sort_index: depth * 100 + tracks.length },
      });
      tracks.push(lane);
      lanes.set(key, tracks);
    }
    lane.end = BigInt(span.endTimeUnixNano);
    return {
      name: span.name,
      cat: "zencodex",
      ph: "X",
      pid,
      tid: lane.tid,
      ts: Number(BigInt(span.startTimeUnixNano) / 1000n),
      dur: Number(
        (BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1000n,
      ),
      args: {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        attributes: span.attributes,
        status: span.status,
      },
    };
  });
  return { traceEvents: [...metadata, ...events] };
}
if (import.meta.main) {
  const directory = process.argv[2] ?? defaultTraceDirectory();
  console.log(JSON.stringify(await traceEvents(directory, process.argv[3])));
}
