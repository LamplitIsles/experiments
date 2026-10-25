import { resolve } from "node:path";
import { abandonFixture } from "../server/abandon-close-fixture";
import { HostService } from "../server/hosts";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket } from "../server/chord-socket";
const origin = "http://127.0.0.1:14327";
let f = await abandonFixture();
let closeFailure = false,
  closeDelay = 0,
  closeCalls = 0,
  candidateDelay = 0;
function service() {
  const candidate = f.app.abandonCloseCandidate.bind(f.app);
  f.app.abandonCloseCandidate = async (id) => {
    const state = await candidate(id);
    if (candidateDelay) await Bun.sleep(candidateDelay);
    return state;
  };
  const originalClose = f.app.closeTree.bind(f.app);
  f.app.closeTree = async (...args) => {
    closeCalls++;
    const result = await originalClose(...args);
    return result;
  };
  f.runtime.closeOverride = async () => {
    if (closeDelay) await Bun.sleep(closeDelay);
    if (closeFailure) throw new Error("fixture native release failed");
  };
  return new HostService(f.app, {
    directory: f.directory,
    name: "Owned fixture",
    origin: () => origin,
  });
}
let owner = service();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 14327,
  idleTimeout: 0,
  websocket: groveWebsocket,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/reset") {
      f.cleanup();
      f = await abandonFixture();
      closeFailure = false;
      closeDelay = 0;
      closeCalls = 0;
      candidateDelay = 0;
      owner = service();
      return Response.json({
        target: `${owner.identity.id}:${f.target.id}`,
        other: `${owner.identity.id}:${f.other.id}`,
      });
    }
    if (url.pathname === "/fixture/change") {
      const body = await request.json();
      closeFailure = body.closeFailure ?? closeFailure;
      closeDelay = body.closeDelay ?? closeDelay;
      candidateDelay = body.candidateDelay ?? candidateDelay;
      if (body.newUnknown)
        await f.app.send(f.target.id, "New unconfirmed input", "new-unknown");
      if (body.active)
        f.runtime.emit(f.target.id, {
          type: "working",
          turnId: "active-fixture",
        });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/info")
      return Response.json({
        closed: f.stored().agents.find((a) => a.id === f.target.id)!.closed,
        lookup: f.app.lookup(f.target.id, "original-unknown"),
        original: f.stored().agents.find((a) => a.id === f.target.id)!
          .deliveries[0],
        active: owner.snapshot().agents.map((a) => a.id),
        inputs: f.runtime.inputs.length,
        closeCalls,
      });
    const options = {
      service: owner,
      origin: () => origin,
      assets: resolve(
        process.env.GROVE_TEST_ASSETS ??
          "../.scratch/abandon-unconfirmed-session/assets",
      ),
    };
    const upgraded = createUpgrade(f.app, options)(request, server);
    if (upgraded) return upgraded === true ? undefined : upgraded;
    return createHandler(f.app, options)(request);
  },
});
console.log(origin);
function stop() {
  server.stop(true);
  f.cleanup();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
