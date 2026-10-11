import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import sharp from "sharp";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/composer-voice-two-rows/screenshots";
const input = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });

async function setup(
  page: Page,
  request: APIRequestContext,
  width = 1440,
  mode = "success",
  fixtureMode = "working",
) {
  await request.post(origin + "/fixture/reset", {
    data: { mode: fixtureMode },
  });
  await request.post(origin + "/fixture/voice", { data: { mode } });
  await page.addInitScript(() => {
    const state = window as any;
    state.capture = {
      tracks: 0,
      contexts: 0,
      audioContexts: 0,
      calls: 0,
      hold: false,
      deny: false,
      release: undefined,
    };
    const Original = window.AudioContext;
    window.AudioContext = new Proxy(Original, {
      construct(target, args) {
        const context = Reflect.construct(target, args) as AudioContext;
        state.capture.audioContexts++;
        const addModule = context.audioWorklet.addModule.bind(
          context.audioWorklet,
        );
        context.audioWorklet.addModule = async (...args) => {
          if (state.capture.failWorklet)
            throw new Error("Synthetic Worklet failure");
          return addModule(...args);
        };
        const close = context.close.bind(context);
        let closed = false;
        context.close = async () => {
          if (closed) return;
          closed = true;
          try {
            await close();
          } finally {
            state.capture.audioContexts--;
          }
        };
        return context;
      },
    });
    // Use actual WebAudio and actual production AudioWorklet, with a test oscillator.
    navigator.mediaDevices.getUserMedia = async () => {
      state.capture.calls++;
      if (state.capture.deny)
        throw new DOMException("Synthetic refusal", "NotAllowedError");
      if (state.capture.hold)
        await new Promise<void>((resolve) => {
          state.capture.release = resolve;
        });
      const context = new Original({ sampleRate: 16000 });
      state.capture.contexts++;
      const oscillator = context.createOscillator(),
        destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      if (state.capture.pattern)
        oscillator.frequency.linearRampToValueAtTime(
          880,
          context.currentTime + 10,
        );
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      const track = destination.stream.getAudioTracks()[0],
        stop = track.stop.bind(track);
      state.capture.tracks++;
      let stopped = false;
      track.stop = () => {
        if (stopped) return;
        stopped = true;
        stop();
        state.capture.tracks--;
        oscillator.stop();
        void context.close().then(() => state.capture.contexts--);
      };
      return destination.stream;
    };
    state.pcm = [];
    state.remoteReady = 0;
    const OriginalSocket = window.WebSocket;
    window.WebSocket = new Proxy(OriginalSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        if (String(args[0]).includes("/api/voice/stream")) {
          const buffered = Object.getOwnPropertyDescriptor(
            OriginalSocket.prototype,
            "bufferedAmount",
          )!.get!;
          Object.defineProperty(socket, "bufferedAmount", {
            get: () =>
              state.capture.backpressure ? 256 * 1024 : buffered.call(socket),
          });
          const onmessage = Object.getOwnPropertyDescriptor(
            OriginalSocket.prototype,
            "onmessage",
          )!;
          Object.defineProperty(socket, "onmessage", {
            set(handler) {
              if (!handler) {
                onmessage.set!.call(socket, handler);
                return;
              }
              onmessage.set!.call(socket, (event: MessageEvent) => {
                if (
                  state.capture.wrongPeer &&
                  typeof event.data === "string" &&
                  JSON.parse(event.data).type === "ready"
                )
                  event = new MessageEvent("message", {
                    data: JSON.stringify({
                      type: "ready",
                      peerId: "unrelated",
                    }),
                  });
                handler.call(socket, event);
              });
            },
          });
        }
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            try {
              if (JSON.parse(event.data).type === "ready")
                state.remoteReady = Date.now();
            } catch {}
          }
        });
        return socket;
      },
    });
    state.firstPCM = 0;
    const OriginalNode = window.AudioWorkletNode;
    window.AudioWorkletNode = new Proxy(OriginalNode, {
      construct(target, args) {
        const node = Reflect.construct(target, args) as AudioWorkletNode;
        node.port.addEventListener("message", (event) => {
          if (event.data instanceof ArrayBuffer) {
            state.firstPCM ||= Date.now();
            state.pcm.push(Array.from(new Uint8Array(event.data)));
          }
        });
        node.port.start();
        return node;
      },
    });
    state.sends = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          const frame = JSON.parse(data);
          if (frame.call?.member === "send") state.sends.push(frame);
        } catch {}
      }
      return send.call(this, data);
    };
  });
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(origin);
  if (width === 390)
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
  await expect(input(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeEnabled();
}
async function record(page: Page, request: APIRequestContext) {
  const stats = await (await request.get(origin + "/fixture/voice")).json();
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: /Recording/ }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/voice")).json()).bytes,
    )
    .toBeGreaterThan(stats.bytes);
}
async function providerReady(request: APIRequestContext, runs: number) {
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/voice")).json()).runs
          .length,
    )
    .toBeGreaterThan(runs);
  await request.post(origin + "/fixture/voice", { data: { ready: true } });
}
async function released(page: Page, request: APIRequestContext) {
  await expect
    .poll(() => page.evaluate(() => (window as any).capture.tracks))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).capture.contexts))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).capture.audioContexts))
    .toBe(0);
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/voice")).json()).active,
    )
    .toBe(0);
}

for (const width of [1440, 390])
  test(`two rows and actual AudioWorklet final draft/explicit send at ${width}`, async ({
    page,
    request,
  }) => {
    await setup(page, request, width);
    await input(page).fill("before old after");
    await input(page).evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(7, 10),
    );
    await page.getByLabel("Choose message images").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 16, height: 16, channels: 4, background: "#408080" },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    const geometry = await page.evaluate(() => {
      const first = document
          .querySelector(".composer-bottom")!
          .getBoundingClientRect(),
        second = document.querySelector(".workflow-tools")!;
      const send = document
        .querySelector('.composer-actions button[type="submit"]')!
        .getBoundingClientRect();
      return {
        firstBottom: first.bottom,
        secondTop: second.getBoundingClientRect().top,
        scroll: second.scrollWidth > second.clientWidth,
        sendRight: send.right,
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    expect(geometry.secondTop).toBeGreaterThanOrEqual(geometry.firstBottom);
    expect(geometry.sendRight).toBeLessThanOrEqual(width);
    expect(geometry.pageWidth).toBeLessThanOrEqual(width);
    expect(
      await page.locator(".workflow-tools button").allTextContents(),
    ).toEqual(["Discuss", "Implement", "Review", "Re-review", "Research"]);
    if (width === 390) {
      expect(geometry.scroll).toBe(true);
      await page
        .locator(".workflow-tools")
        .evaluate((el) => (el.scrollLeft = el.scrollWidth));
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeInViewport();
      await page
        .locator(".workflow-tools")
        .evaluate((el) => (el.scrollLeft = 0));
    }
    await page.screenshot({ path: `${shots}/${width}-idle.png` });
    await record(page, request);
    await expect(input(page)).toHaveAttribute("readonly", "");
    await expect(input(page)).toHaveValue("before old after");
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Search skills…", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Discuss", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Remove image 1" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Stop Orc", exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: `${shots}/${width}-recording.png` });
    await page
      .getByRole("button", { name: "Stop recording", exact: true })
      .click();
    await expect(input(page)).toHaveValue("before 你好世界 after");
    await expect(input(page)).not.toHaveAttribute("readonly", "");
    expect(
      await input(page).evaluate(
        (el: HTMLTextAreaElement) => el.selectionStart,
      ),
    ).toBe(11);
    expect(await page.evaluate(() => (window as any).sends.length)).toBe(0);
    await released(page, request);
    const stats = await (await request.get(origin + "/fixture/voice")).json();
    expect(stats.nonzero).toBe(true);
    expect(stats.runs.at(-1).payload.parameters.sample_rate).toBe(16000);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(input(page)).toHaveValue("");
    await expect
      .poll(() => page.evaluate(() => (window as any).sends.length))
      .toBe(1);
  });

test("desktop Skill search and built-in insertion retain caret and IME", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await input(page).fill("before after");
  await input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(7, 7),
  );
  await page.getByRole("button", { name: "Discuss", exact: true }).click();
  await expect(input(page)).toHaveValue("before $grove-grill-with-docs after");
  await page
    .getByRole("button", { name: "Search skills…", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Search skills…" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await input(page).dispatchEvent("compositionstart");
  await page.getByRole("button", { name: "Implement", exact: true }).click();
  await expect(input(page)).toHaveValue("before $grove-grill-with-docs after");
  await input(page).dispatchEvent("compositionend");
});

test("permission startup locks input and Escape cancels late tracks without leaving detail", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await input(page).fill("protected");
  await page.evaluate(() => ((window as any).capture.hold = true));
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Starting microphone" }),
  ).toBeVisible();
  await expect(input(page)).toHaveAttribute("readonly", "");
  await page.keyboard.press("Escape");
  await expect(input(page)).toHaveValue("protected");
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => (window as any).capture.release());
  await released(page, request);
  await expect(page.locator(".inline-error")).toHaveCount(0);
});

test("cancel/failed result preserve draft; retry and second take append; images/paste/drop stay protected", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await input(page).fill("original");
  await record(page, request);
  await input(page).evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([1])], "invalid.png", { type: "image/png" }),
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
    el.closest("form")!.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.getByRole("button", { name: "Cancel voice input" }).click();
  await released(page, request);
  await expect(input(page)).toHaveValue("original");
  await expect(page.locator(".image-draft")).toHaveCount(0);
  await expect(page.locator(".inline-error")).toHaveCount(0);
  await request.post(origin + "/fixture/voice", { data: { mode: "failure" } });
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Voice input failed");
  await expect(input(page)).toHaveValue("original");
  await released(page, request);
  await request.post(origin + "/fixture/voice", { data: { mode: "success" } });
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("original你好世界");
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("original你好世界你好世界");
  await released(page, request);
});

test("transcribing cancel, recovery, hidden page, navigation and Peer switch isolate late results", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "hold-finish");
  await input(page).fill("local draft");
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Recognizing" }),
  ).toBeVisible();
  // Programmatic image recovery replaces text, invalidating the old take.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.includes("/composer/"),
    )!;
    const id = key.split("/composer/")[1];
    localStorage.setItem(key, "recovered draft");
    window.dispatchEvent(
      new CustomEvent("grove-image-recovery", { detail: id }),
    );
  });
  await released(page, request);
  await request.post(origin + "/fixture/voice", {
    data: { release: true, mode: "success" },
  });
  await expect(input(page)).toHaveValue("recovered draft");
  await record(page, request);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await released(page, request);
  await expect(input(page)).toHaveValue("recovered draft");
  await page.evaluate(() =>
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    }),
  );
  await record(page, request);
  await page.getByRole("button", { name: "Neil’s Mac", exact: true }).click();
  await released(page, request);
  await expect(input(page)).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeEnabled();
  await input(page).fill("remote draft");
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("remote draft你好世界");
  await released(page, request);
  await page.getByRole("button", { name: "NUC", exact: true }).click();
  await expect(input(page)).toHaveValue("recovered draft");
  await record(page, request);
  await page.goBack();
  await released(page, request);
});

test("missing config and denied microphone allow text and retry", async ({
  page,
  request,
}) => {
  await setup(page, request, 390);
  await page.evaluate(() => ((window as any).capture.deny = true));
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Allow microphone");
  await expect(input(page)).not.toHaveAttribute("readonly", "");
  await request.post(origin + "/fixture/voice", { data: { disabled: true } });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Voice is not configured on this Peer" }),
  ).toHaveCount(0);
  await input(page).fill("still editable");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await expect(input(page)).not.toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${shots}/390-missing-config.png` });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).sends.length))
    .toBe(1);
  await request.post(origin + "/fixture/voice", { data: { disabled: false } });
  await page.addInitScript(() =>
    Object.defineProperty(window, "AudioWorkletNode", { value: undefined }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toHaveAttribute("title", /supported browser/);
  await expect(
    page.getByRole("status").filter({
      hasText: "Voice requires HTTPS or localhost and a supported browser",
    }),
  ).toHaveCount(0);
  await input(page).fill("unsupported capture still sends");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: `${shots}/390-unsupported.png` });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).sends.length))
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeDisabled();
});

test("Escape preserves foreground title hierarchy then cancels voice without leaving conversation", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await input(page).fill("keep draft");
  await record(page, request);
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Session title", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Session title", exact: true }),
  ).toBeHidden();
  await expect(input(page)).toHaveAttribute("readonly", "");
  await page.keyboard.press("Escape");
  await released(page, request);
  await expect(input(page)).toHaveValue("keep draft");
});

test("startup transport cancellation, session switch with pending final and remote disconnect release capture", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "hold-start", "host-selection");
  await input(page).fill("first session draft");
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/voice")).json()).active,
    )
    .toBe(1);
  await page.getByRole("button", { name: "Cancel voice input" }).click();
  await released(page, request);
  await expect(input(page)).toHaveValue("first session draft");
  await request.post(origin + "/fixture/voice", {
    data: { mode: "hold-finish" },
  });
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Recognizing" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open NUC second session Orc", exact: true })
    .click();
  await released(page, request);
  await input(page).fill("second session draft");
  await request.post(origin + "/fixture/voice", {
    data: { mode: "success", release: true },
  });
  await expect(input(page)).toHaveValue("second session draft");
  await page
    .getByRole("button", {
      name: "Open Streaming voice input Orc",
      exact: true,
    })
    .click();
  await expect(input(page)).toHaveValue("first session draft");
  await page.getByRole("button", { name: "Neil’s Mac", exact: true }).click();
  await record(page, request);
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await released(page, request);
  await expect(input(page)).not.toHaveAttribute("readonly", "");
});

test("empty final during startup keeps actual capture recording until explicit Finish", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "empty-start");
  await input(page).fill("preserved ");
  await record(page, request);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Cancel voice input", exact: true })
    .click();
  await released(page, request);
  await expect(input(page)).toHaveValue("preserved ");
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("preserved 你好世界");
  await released(page, request);
});

test("capability checks are silent and bounded across detail refresh and unavailable reload", async ({
  page,
  request,
}) => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/voice/capability", async (route) => {
    calls++;
    await held;
    await route.continue();
  });
  // Existing setup waits for enabled microphone: release after first check so we can inspect startup.
  const starting = setup(page, request, 390);
  await expect.poll(() => calls).toBeGreaterThan(0);
  await expect(input(page)).toBeVisible();
  const microphone = page.getByRole("button", {
    name: "Start voice input",
    exact: true,
  });
  await expect(microphone).toBeDisabled();
  await expect(page.locator(".voice-status")).toHaveCount(0);
  const rect = await page.locator(".composer-bottom").boundingBox();
  await page.screenshot({
    path: "../.scratch/voice-immediate-failure/screenshots/390-checking.png",
  });
  release();
  await starting;
  expect(await page.locator(".composer-bottom").boundingBox()).toEqual(rect);
  const initial = calls;
  await request.post(origin + "/fixture/change", {
    data: {
      append: { agentId: "orc", text: "refresh without changing connection" },
    },
  });
  await expect(
    page.getByText("refresh without changing connection", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(calls).toBe(initial);
  await request.post(origin + "/fixture/voice", { data: { disabled: true } });
  await page.reload();
  await expect(microphone).toHaveAttribute("title", /not configured/);
  await expect(microphone).toBeDisabled();
  await expect(page.locator(".voice-status")).toHaveCount(0);
  await input(page).fill("silent availability still sends");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Add images", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Choose message images").setInputFiles({
    name: "silent.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 16, height: 16, channels: 4, background: "#408080" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await page.screenshot({
    path: "../.scratch/voice-immediate-failure/screenshots/390-unavailable.png",
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).sends.length))
    .toBe(1);
});

for (const width of [1440, 390])
  test(`inline live voice status keeps toolbar geometry at ${width}`, async ({
    page,
    request,
  }) => {
    await setup(page, request, width, "hold-finish");
    await input(page).fill("protected draft");
    const skills = page.getByRole("button", {
      name: "Search skills…",
      exact: true,
    });
    const status = page.locator(".voice-status");
    const geometry = () =>
      page.evaluate(() =>
        [".composer", ".composer-bottom", ".workflow-tools"].map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect();
          return { y: box.y, height: box.height };
        }),
      );
    const baseline = await geometry();
    const check = async (phase: string) => {
      expect(await geometry()).toEqual(baseline);
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Stop Orc", exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      if (phase !== "idle") {
        await expect(skills).toHaveCount(0);
        await expect(status).toHaveAttribute("role", "status");
        await expect(status).toHaveAttribute("aria-live", "polite");
        const mic = await page
          .getByRole("button", { name: "Stop recording", exact: true })
          .boundingBox();
        const box = await status.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(mic!.x + mic!.width);
        expect(box!.y).toBeGreaterThanOrEqual(mic!.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(mic!.y + mic!.height);
      } else {
        await expect(skills).toBeEnabled();
        await expect(status).toHaveCount(0);
      }
      await page.screenshot({
        path: `../.scratch/inline-voice-status/screenshots/${width}-${phase}.png`,
      });
    };
    await check("idle");
    await page.evaluate(() => ((window as any).capture.hold = true));
    await page
      .getByRole("button", { name: "Start voice input", exact: true })
      .click();
    await expect(status).toHaveText("Starting microphone…");
    await check("starting");
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).capture.release))
      .toBe("function");
    await page.evaluate(() => (window as any).capture.release());
    await expect(status).toHaveText(/Recording 0:0[1-9]/);
    await check("recording");
    await page
      .getByRole("button", { name: "Stop recording", exact: true })
      .click();
    await expect(status).toHaveText("Recognizing…");
    await check("recognizing");
    await request.post(origin + "/fixture/voice", { data: { release: true } });
    await expect(input(page)).toHaveValue("protected draft你好世界");
    await check("idle");
    await released(page, request);
    await page.evaluate(() => ((window as any).capture.hold = false));
    await record(page, request);
    await page.getByRole("button", { name: "Cancel voice input" }).click();
    await check("idle");
    await released(page, request);
    await request.post(origin + "/fixture/voice", {
      data: { mode: "failure" },
    });
    await record(page, request);
    await page
      .getByRole("button", { name: "Stop recording", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Voice input failed");
    await expect(skills).toBeEnabled();
    await expect(status).toHaveCount(0);
    await expect(input(page)).toHaveValue("protected draft你好世界");
    await released(page, request);
  });

for (const width of [1440, 390])
  test(`delayed ready captures locally and short Stop delivers exact PCM at ${width}`, async ({
    page,
    request,
  }) => {
    await setup(page, request, width, "hold-start");
    await page.evaluate(() => ((window as any).capture.pattern = true));
    await input(page).fill("before old after");
    await input(page).evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(7, 10),
    );
    const baseline = await page.locator(".composer-bottom").boundingBox();
    const before = await (await request.get(origin + "/fixture/voice")).json();
    const click = Date.now();
    await page
      .getByRole("button", { name: "Start voice input", exact: true })
      .click();
    await expect(page.locator(".voice-status")).toHaveText(/Recording/);
    expect(
      await page.evaluate(() => (window as any).pcm.length),
    ).toBeGreaterThan(0);
    expect(
      (await (await request.get(origin + "/fixture/voice")).json()).frames,
    ).toBe(before.frames);
    expect(await page.locator(".composer-bottom").boundingBox()).toEqual(
      baseline,
    );
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Stop Orc", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: `../.scratch/fast-voice-start/screenshots/${width}-early-recording.png`,
    });
    await page
      .getByRole("button", { name: "Stop recording", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).capture.tracks))
      .toBe(0);
    const pcm = await page.evaluate(() => (window as any).pcm);
    expect(pcm.length).toBeGreaterThan(0);
    expect(
      (await (await request.get(origin + "/fixture/voice")).json()).finishes,
    ).toBe(before.finishes);
    const readyReleaseAttempt = Date.now();
    await providerReady(request, before.runs.length);
    await expect(input(page)).toHaveValue("before 你好世界 after");
    await released(page, request);
    const after = await (await request.get(origin + "/fixture/voice")).json();
    expect(pcm[0]).not.toEqual(pcm[1]);
    expect(after.pcm.slice(before.pcm.length)).toEqual(pcm);
    expect(after.events.slice(before.events.length)).toEqual([
      "ready",
      ...pcm.map(() => "pcm"),
      "finish",
    ]);
    expect(await page.evaluate(() => (window as any).sends.length)).toBe(0);
    console.log(
      JSON.stringify({
        width,
        clickToFirstPCM: await page.evaluate(
          (click) => (window as any).firstPCM - click,
          click,
        ),
        clickToRemoteReady: await page.evaluate(
          (click) => (window as any).remoteReady - click,
          click,
        ),
        clickToReadyReleaseAttempt: readyReleaseAttempt - click,
        frames: pcm.length,
        bytes: pcm.flat().length,
      }),
    );
    await page.screenshot({
      path: `../.scratch/fast-voice-start/screenshots/${width}-idle.png`,
    });
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).sends.length))
      .toBe(1);
  });

test("delayed ready drains then streams without PCM gaps or duplicates", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "hold-start");
  await page.evaluate(() => ((window as any).capture.pattern = true));
  const before = await (await request.get(origin + "/fixture/voice")).json();
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).pcm.length))
    .toBeGreaterThanOrEqual(3);
  expect(
    (await (await request.get(origin + "/fixture/voice")).json()).frames,
  ).toBe(before.frames);
  await providerReady(request, before.runs.length);
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/voice")).json()).frames -
        before.frames,
    )
    .toBeGreaterThanOrEqual(6);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("你好世界");
  await released(page, request);
  const after = await (await request.get(origin + "/fixture/voice")).json();
  const pcm = await page.evaluate(() => (window as any).pcm);
  expect(pcm[0]).not.toEqual(pcm[1]);
  expect(after.pcm.slice(before.pcm.length)).toEqual(pcm);
  expect(after.events.slice(before.events.length)).toEqual([
    "ready",
    ...pcm.map(() => "pcm"),
    "finish",
  ]);
});

test("startup queue overflow releases capture and next take works", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "hold-start");
  await input(page).fill("keep ");
  const before = await (await request.get(origin + "/fixture/voice")).json();
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.locator(".voice-status")).toHaveText(/Recording/);
  await expect(page.getByRole("alert")).toContainText("Voice input failed", {
    timeout: 10_000,
  });
  await released(page, request);
  expect(
    (await (await request.get(origin + "/fixture/voice")).json()).frames,
  ).toBe(before.frames);
  expect(
    await page.evaluate(() =>
      (window as any).pcm.reduce(
        (sum: number, frame: number[]) => sum + frame.length,
        0,
      ),
    ),
  ).toBe(163200);
  await expect(input(page)).toHaveValue("keep ");
  await request.post(origin + "/fixture/voice", { data: { ready: true } });
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("keep 你好世界");
  await released(page, request);
});

test("early local Recording does not remove remote startup timeout", async ({
  page,
  request,
}) => {
  test.setTimeout(40_000);
  await setup(page, request, 1440, "hold-start");
  await input(page).fill("protected");
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.locator(".voice-status")).toHaveText(/Recording/);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).capture.tracks))
    .toBe(0);
  await expect(page.getByRole("alert")).toContainText("Voice input failed", {
    timeout: 18_000,
  });
  await released(page, request);
  await expect(input(page)).toHaveValue("protected");
});

test("cancel while capability is pending closes late socket and discards PCM", async ({
  page,
  request,
}) => {
  await setup(page, request);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/voice/capability", async (route) => {
    await held;
    await route.continue();
  });
  await input(page).fill("protected");
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.locator(".voice-status")).toHaveText(/Recording/);
  await page.getByRole("button", { name: "Cancel voice input" }).click();
  release();
  await released(page, request);
  await page.waitForTimeout(200);
  await expect(input(page)).toHaveValue("protected");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("protected你好世界");
  await released(page, request);
});

test("ready during permission wait never labels Recording before PCM", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await page.evaluate(() => ((window as any).capture.hold = true));
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).remoteReady))
    .toBeGreaterThan(0);
  await expect(page.locator(".voice-status")).toHaveText(
    "Starting microphone…",
  );
  expect(await page.evaluate(() => (window as any).pcm.length)).toBe(0);
  await page.evaluate(() => (window as any).capture.release());
  await expect(page.locator(".voice-status")).toHaveText(/Recording/);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("你好世界");
  await released(page, request);
});

test("wrong owning-Peer ready rejects buffered speech and next take recovers", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "hold-start");
  await page.evaluate(() => ((window as any).capture.wrongPeer = true));
  await input(page).fill("keep");
  const before = await (await request.get(origin + "/fixture/voice")).json();
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.locator(".voice-status")).toHaveText(/Recording/);
  await providerReady(request, before.runs.length);
  await expect(page.getByRole("alert")).toContainText("Voice input failed");
  await released(page, request);
  expect(
    (await (await request.get(origin + "/fixture/voice")).json()).frames,
  ).toBe(before.frames);
  await expect(input(page)).toHaveValue("keep");
  await page.evaluate(() => ((window as any).capture.wrongPeer = false));
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("keep你好世界");
  await released(page, request);
});

test("Worklet setup failure and Cancel before PCM release both concurrent branches", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await input(page).fill("keep");
  await page.evaluate(() => ((window as any).capture.failWorklet = true));
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Voice input failed");
  await released(page, request);
  await page.evaluate(() => {
    (window as any).capture.failWorklet = false;
    (window as any).capture.hold = true;
  });
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).remoteReady))
    .toBeGreaterThan(0);
  await expect(page.locator(".voice-status")).toHaveText(
    "Starting microphone…",
  );
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel voice input" }).click();
  await page.evaluate(() => (window as any).capture.release());
  await released(page, request);
  await expect(input(page)).toHaveValue("keep");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => ((window as any).capture.hold = false));
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("keep你好世界");
  await released(page, request);
});

test("bounded drain respects socket backpressure and cancellation", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "hold-start");
  await page.evaluate(() => ((window as any).capture.pattern = true));
  await input(page).fill("keep");
  for (const cancel of [true, false]) {
    await request.post(origin + "/fixture/voice", {
      data: { mode: "hold-start" },
    });
    await page.evaluate(() => {
      (window as any).pcm = [];
      (window as any).capture.backpressure = false;
    });
    const before = await (await request.get(origin + "/fixture/voice")).json();
    await page
      .getByRole("button", { name: "Start voice input", exact: true })
      .click();
    await expect(page.locator(".voice-status")).toHaveText(/Recording/);
    await page
      .getByRole("button", { name: "Stop recording", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).capture.tracks))
      .toBe(0);
    const pcm = await page.evaluate(() => (window as any).pcm);
    await page.evaluate(() => ((window as any).capture.backpressure = true));
    await providerReady(request, before.runs.length);
    await page.waitForTimeout(100);
    const blocked = await (await request.get(origin + "/fixture/voice")).json();
    expect(blocked.frames).toBe(before.frames);
    expect(blocked.finishes).toBe(before.finishes);
    if (cancel)
      await page.getByRole("button", { name: "Cancel voice input" }).click();
    await page.evaluate(() => ((window as any).capture.backpressure = false));
    if (!cancel) {
      await expect(input(page)).toHaveValue("keep你好世界");
      const after = await (await request.get(origin + "/fixture/voice")).json();
      expect(pcm[0]).not.toEqual(pcm[1]);
      expect(after.pcm.slice(before.pcm.length)).toEqual(pcm);
      expect(after.events.slice(before.events.length)).toEqual([
        "ready",
        ...pcm.map(() => "pcm"),
        "finish",
      ]);
    } else await expect(input(page)).toHaveValue("keep");
    await released(page, request);
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
});

test("capability failure after local PCM preserves draft and permits retry", async ({
  page,
  request,
}) => {
  await setup(page, request);
  let fail = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/voice/capability", async (route) => {
    if (!fail) return route.continue();
    await held;
    await route.fulfill({ status: 503, body: "Test unavailable" });
  });
  await input(page).fill("keep");
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.locator(".voice-status")).toHaveText(/Recording/);
  release();
  await expect(page.getByRole("alert")).toContainText("Voice input failed");
  await released(page, request);
  await expect(input(page)).toHaveValue("keep");
  fail = false;
  await record(page, request);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(input(page)).toHaveValue("keep你好世界");
  await released(page, request);
});
