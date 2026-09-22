import { expect, test } from "bun:test";
import { MarkdownRenderable, SyntaxStyle, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

test("completed output commits once to scrollback and releases its renderable", async () => {
  const setup = await createTestRenderer({
    width: 60,
    height: 16,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
  });
  try {
    const input = new TextRenderable(setup.renderer, {
      content: "Composer stays live",
    });
    setup.renderer.root.add(input);
    let message: TextRenderable | undefined;
    setup.renderer.writeToScrollback(({ renderContext, width }) => {
      message = new TextRenderable(renderContext, {
        content: "Completed answer",
        width,
        height: 1,
      });
      return { root: message, width, height: 1, trailingNewline: true };
    });
    await setup.flush();
    expect(setup.externalOutput.takeText()).toContain("Completed answer");
    expect(message!.isDestroyed).toBe(true);
    expect(setup.captureCharFrame()).toContain("Composer stays live");
    await setup.flush();
    expect(setup.externalOutput.takeText()).toBe("");
    setup.resize(40, 12);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Composer stays live");
  } finally {
    setup.renderer.destroy();
  }
});

test("complete Markdown uses measured rows and reflows after resize", async () => {
  const setup = await createTestRenderer({
    width: 60,
    height: 16,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
  });
  const syntax = SyntaxStyle.fromStyles({});
  try {
    const render = async () => {
      const surface = setup.renderer.createScrollbackSurface();
      try {
        surface.root.add(
          new MarkdownRenderable(surface.renderContext, {
            width: "100%",
            flexShrink: 0,
            streaming: false,
            conceal: true,
            syntaxStyle: syntax,
            content:
              "# Finished answer\n\n" +
              "Long completed paragraph. ".repeat(12) +
              "\n\n- final bullet\n\n**End marker**",
          }),
        );
        await surface.settle();
        const rows = surface.height;
        surface.commitRows(0, rows, { trailingNewline: true });
        return rows;
      } finally {
        surface.destroy();
      }
    };
    const wideRows = await render();
    await setup.flush();
    const wide = setup.externalOutput.takeText();
    expect(wide).toContain("Finished answer");
    expect(wide).toContain("final bullet");
    expect(wide).toContain("End marker");
    setup.resize(30, 16);
    const narrowRows = await render();
    await setup.flush();
    const narrow = setup.externalOutput.takeText();
    expect(narrow).toContain("End marker");
    expect(narrow.match(/Finished answer/g)).toHaveLength(1);
    expect(narrowRows).toBeGreaterThan(wideRows);
  } finally {
    setup.renderer.destroy();
    syntax.destroy();
  }
});
