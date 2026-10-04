// Only the Hub's native Bun socket probes execution hosts. Browser clients use
// the Hub's replicated host state; business RPCs never decide host liveness.
export function monitorHost(
  socket: WebSocket,
  failed: () => void,
  intervalMs = 15_000,
  timeoutMs = 10_000,
  alive: () => void = () => {},
) {
  const native = socket as WebSocket & {
    ping(data: string): void;
    terminate(): void;
  };
  let sequence = 0;
  let expected: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(deadline);
    socket.removeEventListener("pong", pong);
    socket.removeEventListener("close", stop);
    socket.removeEventListener("error", stop);
  }
  function fail() {
    stop();
    failed();
    native.terminate();
  }
  function pong(event: Event) {
    const data = (event as MessageEvent).data;
    if (
      expected === undefined ||
      !(data instanceof Uint8Array) ||
      new TextDecoder().decode(data) !== expected
    )
      return;
    expected = undefined;
    clearTimeout(deadline);
    alive();
  }
  const interval = setInterval(() => {
    if (expected !== undefined || stopped) return;
    if (socket.readyState !== 1) {
      stop();
      return;
    }
    expected = `grove-${++sequence}`;
    deadline = setTimeout(fail, timeoutMs);
    try {
      native.ping(expected);
    } catch {
      fail();
    }
  }, intervalMs);
  socket.addEventListener("pong", pong);
  socket.addEventListener("close", stop, { once: true });
  socket.addEventListener("error", stop, { once: true });
  return stop;
}
