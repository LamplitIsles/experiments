import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";

test.skipIf(process.platform === "win32")(
  "real PTY pins the first shell and preserves a host-scrolled viewport through output and resize",
  async () => {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 2000,
      allowProposedApi: true,
    });
    const phases = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<void>>
    >();
    const phase = (name: string) => {
      if (!phases.has(name)) phases.set(name, Promise.withResolvers<void>());
      return phases.get(name)!;
    };
    terminal.parser.registerOscHandler(777, (data) => {
      if (!data.startsWith("zencodex-test:")) return false;
      phase(data.slice("zencodex-test:".length)).resolve();
      return true;
    });
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./reader-pty-fixture.ts", import.meta.url).pathname,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, HERDR_ENV: "0", ZENCODEX_TRACE: "0" },
        ipc() {},
        terminal: {
          cols: 80,
          rows: 24,
          data(_pty, bytes) {
            terminal.write(bytes);
          },
        },
      },
    );
    const response = terminal.onData((data) => child.terminal!.write(data));
    const wait = async (name: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          phase(name).promise,
          child.exited.then((code) => {
            throw new Error(`Fixture exited ${code} before ${name}`);
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out at ${name}`)),
              4000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const row = (index: number) =>
      terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";
    const footer = () => row(terminal.buffer.active.baseY + terminal.rows - 1);
    const text = () =>
      Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        row(i),
      ).join("\n");
    try {
      await wait("shell");
      expect(terminal.buffer.active.type).toBe("normal");
      expect(footer()).toContain("Enter send/steer");
      expect(row(terminal.buffer.active.baseY + 17)).toContain(
        "Fixture reader",
      );

      child.terminal!.write("/cmp");
      child.send({ action: "completion" });
      await wait("completion");
      expect(footer()).toContain("Enter send/steer");
      child.terminal!.write("\t");

      child.send({ action: "history" });
      await wait("history");
      expect(footer()).toContain("Enter send/steer");
      expect(text()).toContain("HISTORY 000");
      expect(text()).toContain("HISTORY 039");

      terminal.scrollLines(-25);
      const viewport = terminal.buffer.active.viewportY;
      const before = Array.from({ length: 5 }, (_, i) => row(viewport + i));
      expect(viewport).toBeLessThan(terminal.buffer.active.baseY);
      child.send({ action: "append" });
      await wait("append");
      expect(terminal.buffer.active.viewportY).toBe(viewport);
      expect(Array.from({ length: 5 }, (_, i) => row(viewport + i))).toEqual(
        before,
      );
      expect(text()).toContain("NEW OUTPUT");

      terminal.resize(60, 30);
      child.terminal!.resize(60, 30);
      child.send({ action: "resize", cols: 60, rows: 30 });
      await wait("resize");
      expect(terminal.buffer.active.viewportY).toBeLessThan(
        terminal.buffer.active.baseY,
      );
      expect(text().match(/HISTORY 000/g)).toHaveLength(1);
      terminal.scrollToBottom();
      expect(
        Array.from({ length: terminal.rows }, (_, i) =>
          row(terminal.buffer.active.baseY + i),
        ).findIndex((line) => line.includes("Enter send/steer")),
      ).toBe(29);
      expect(footer()).toContain("Enter send/steer");
      child.send({ action: "quit" });
      expect(await child.exited).toBe(0);
    } finally {
      response.dispose();
      if (child.exitCode === null) child.kill();
      await child.exited;
      child.terminal?.close();
      terminal.dispose();
    }
  },
  15000,
);
