// Executed only by the owned recovery test, with its HOME, provider and repo.
import { join } from "node:path";
import { openPiSession } from "../server/pi-session";
import type { RuntimeAgent } from "../server/runtime";
const agent = JSON.parse(process.argv[2]!) as RuntimeAgent;
const handle = await openPiSession(agent, () => {}, {
  agentDir: process.env.PI_CODING_AGENT_DIR!,
  sessionDir: join(process.env.PI_CODING_AGENT_DIR!, "grove-durable"),
  selection: {
    provider: agent.provider!,
    model: agent.model,
    effort: agent.effort,
  },
  tool: async () => ({ ok: true }),
});
const run = await handle.send("crash accepted", undefined, [], "crash-first");
await handle.send("crash queued", run, [], "crash-queued");
console.log(
  `owned-crash ${JSON.stringify({ threadId: handle.threadId, run })}`,
);
setInterval(() => {}, 1000);
