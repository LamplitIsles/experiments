import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ReviewerProfile } from "../src/contracts";

export const reviewerProfiles = [
  "standards",
  "spec",
  "high_risk_spec",
  "penpot",
] as const;
const profileSchema = z.object({
  model: z.string().trim().min(1),
  reasoning_effort: z.enum([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  prompt_file: z.string().trim().min(1),
});
const configSchema = z.object({
  orc: z.object({ prompt_file: z.string().trim().min(1) }),
  reviewers: z.object({
    standards: profileSchema,
    spec: profileSchema,
    high_risk_spec: profileSchema,
    penpot: profileSchema,
  }),
});
export interface ReviewerSnapshot {
  model: string;
  effort: string;
  prompt: string;
}
const templates = fileURLToPath(new URL("../templates/", import.meta.url));

// Exclusive creation preserves customization and allows partial initialization to retry.
export async function initializeReviewerConfig(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(resolve(dirname(path), "prompts"), {
    recursive: true,
    mode: 0o700,
  });
  for (const [target, source] of [
    [path, resolve(templates, "config.toml")],
    [
      resolve(dirname(path), "prompts/orc.md"),
      resolve(templates, "prompts/orc.md"),
    ],
    ...reviewerProfiles.map((p) => [
      resolve(dirname(path), `prompts/${p}.md`),
      resolve(templates, `prompts/${p}.md`),
    ]),
  ]) {
    try {
      await writeFile(target, await readFile(source), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  await orcPrompt(path);
  for (const profile of reviewerProfiles) await reviewerSnapshot(path, profile);
}
export async function readReviewerConfig(path: string) {
  try {
    return configSchema.parse(Bun.TOML.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Invalid Grove reviewer configuration ${path}: ${String(error)}`,
    );
  }
}
export async function reviewerSnapshot(
  path: string,
  profile: ReviewerProfile,
): Promise<ReviewerSnapshot> {
  const value = (await readReviewerConfig(path)).reviewers[profile];
  const promptPath = resolve(dirname(path), value.prompt_file);
  return {
    model: value.model,
    effort: value.reasoning_effort,
    prompt: await readPrompt(promptPath, "Reviewer"),
  };
}
export async function orcPrompt(path: string) {
  const config = await readReviewerConfig(path);
  return readPrompt(resolve(dirname(path), config.orc.prompt_file), "Orc");
}
async function readPrompt(promptPath: string, role: string) {
  let prompt: string;
  try {
    prompt = await readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read ${role} prompt ${promptPath}: ${String(error)}`,
    );
  }
  if (!prompt.trim()) throw new Error(`${role} prompt is empty: ${promptPath}`);
  return prompt;
}
