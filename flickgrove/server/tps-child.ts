// This entry point alone imports the runtime analyzer. The host imports types.
import { LogAnalyzer } from "@experiments/codex-tps";
import { createInterface } from "node:readline";
const analyzer = new LogAnalyzer();
const root = process.argv[2];
if (!root) process.exit(2);
const memory = setInterval(() => {
  if (process.memoryUsage.rss() > 256 * 1024 * 1024) process.exit(2);
}, 100);
memory.unref();
let busy = false;
for await (const line of createInterface({ input: process.stdin })) {
  if (busy || line.length > 1024) process.exit(2);
  busy = true;
  try {
    const { model, tier, now } = JSON.parse(line);
    if (
      typeof model !== "string" ||
      model.length > 200 ||
      !["fast", "standard"].includes(tier) ||
      !Number.isFinite(now)
    )
      throw new Error();
    const before = process.cpuUsage();
    const result = await analyzer.analyze(root, { model, tier }, now);
    const cpu = process.cpuUsage(before);
    Object.assign(result.metrics, {
      rssBytes: process.memoryUsage.rss(),
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    // Paths, raw records and native error strings stay inside this process.
    process.stdout.write('{"error":true}\n');
  } finally {
    busy = false;
  }
}
