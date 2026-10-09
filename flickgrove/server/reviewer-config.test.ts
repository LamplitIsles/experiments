import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeReviewerConfig,
  readReviewerConfig,
  reviewerSnapshot,
  orcPrompt,
} from "./reviewer-config";

test("configuration initializes missing files, retains customization, retries partial initialization and rejects errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-config-"));
  const path = join(root, "config.toml");
  try {
    await initializeReviewerConfig(path);
    const original = await readFile(path, "utf8");
    expect((await readReviewerConfig(path)).orc.prompt_file).toBe(
      "prompts/orc.md",
    );
    expect(
      (await readFile(join(root, "prompts/orc.md"), "utf8")).trim(),
    ).not.toBe("");
    await writeFile(join(root, "prompts/orc.md"), "Custom Orc scope");
    await initializeReviewerConfig(path);
    expect(await orcPrompt(path)).toBe("Custom Orc scope");
    await unlink(join(root, "prompts/orc.md"));
    await initializeReviewerConfig(path);
    expect((await orcPrompt(path)).trim()).not.toBe("");
    await writeFile(join(root, "custom-orc.md"), "Relative Orc scope");
    await writeFile(path, original.replace("prompts/orc.md", "custom-orc.md"));
    expect(await orcPrompt(path)).toBe("Relative Orc scope");
    await writeFile(join(root, "custom-orc.md"), " ");
    await expect(initializeReviewerConfig(path)).rejects.toThrow(
      "Orc prompt is empty",
    );
    await unlink(join(root, "custom-orc.md"));
    await expect(initializeReviewerConfig(path)).rejects.toThrow(
      "Cannot read Orc prompt",
    );
    await writeFile(
      path,
      original.replace(/\[orc\]\nprompt_file = [^\n]+\n/, ""),
    );
    await expect(initializeReviewerConfig(path)).rejects.toThrow(
      "Invalid Grove reviewer configuration",
    );
    await writeFile(path, original);
    const snapshot = await reviewerSnapshot(path, "standards");
    expect(snapshot).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    await writeFile(join(root, "prompts/standards.md"), "Custom axis scope");
    await unlink(join(root, "prompts/spec.md"));
    await initializeReviewerConfig(path);
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await reviewerSnapshot(path, "standards")).prompt).toBe(
      "Custom axis scope",
    );
    expect(
      (await reviewerSnapshot(path, "spec")).prompt.length,
    ).toBeGreaterThan(0);
    expect(snapshot.prompt).not.toBe("Custom axis scope");
    await writeFile(
      path,
      original.replace("prompts/standards.md", "missing.md"),
    );
    await expect(reviewerSnapshot(path, "standards")).rejects.toThrow(
      "Cannot read Reviewer prompt",
    );
    await writeFile(path, '[reviewers.standards]\nmodel = ""');
    await expect(initializeReviewerConfig(path)).rejects.toThrow(
      "Invalid Grove reviewer configuration",
    );
    await writeFile(path, "invalid [");
    await expect(reviewerSnapshot(path, "spec")).rejects.toThrow(
      "Invalid Grove reviewer configuration",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
