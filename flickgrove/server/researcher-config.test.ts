import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeReviewerConfig,
  researcherSnapshot,
  reviewerSnapshot,
  orcPrompt,
} from "./reviewer-config";
test("existing Peer initializes only missing Researcher config/prompt and preserves custom tables and text", async () => {
  const root = await mkdtemp(join(tmpdir(), "grove-researcher-config-")),
    path = join(root, "config.toml");
  try {
    await initializeReviewerConfig(path);
    const original = await readFile(path, "utf8");
    // Test-owned pre-feature config with comments, custom Orc and Reviewer content.
    const existing =
      "# custom comments remain\n" +
      original.replace(/\[researcher\][\s\S]*?(?=\[reviewers.standards\])/, "");
    await writeFile(path, existing);
    await writeFile(join(root, "prompts/orc.md"), "Custom Orc");
    await writeFile(join(root, "prompts/spec.md"), "Custom Spec");
    await unlink(join(root, "prompts/researcher.md"));
    await initializeReviewerConfig(path);
    const initialized = await readFile(path, "utf8");
    expect(initialized.startsWith(existing)).toBe(true);
    expect(await orcPrompt(path)).toBe("Custom Orc");
    expect((await reviewerSnapshot(path, "spec")).prompt).toBe("Custom Spec");
    const first = await researcherSnapshot(path);
    expect(first).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    await writeFile(
      join(root, "custom-research.md"),
      "Custom question evidence",
    );
    const custom = initialized.replace(
      'prompt_file = "prompts/researcher.md"',
      'prompt_file = "custom-research.md"',
    );
    await writeFile(path, custom);
    await initializeReviewerConfig(path);
    expect(await readFile(path, "utf8")).toBe(custom);
    expect((await researcherSnapshot(path)).prompt).toBe(
      "Custom question evidence",
    );
    expect(first.prompt).not.toBe("Custom question evidence");
    await writeFile(join(root, "custom-research.md"), " ");
    await expect(initializeReviewerConfig(path)).rejects.toThrow(
      "Researcher prompt is empty",
    );
    await unlink(join(root, "custom-research.md"));
    await expect(researcherSnapshot(path)).rejects.toThrow(
      "Cannot read Researcher prompt",
    );
    await writeFile(
      path,
      custom.replace(
        'reasoning_effort = "high"',
        'reasoning_effort = "invalid"',
      ),
    );
    await expect(researcherSnapshot(path)).rejects.toThrow("Invalid Grove");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
