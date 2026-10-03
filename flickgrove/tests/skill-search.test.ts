import { describe, expect, test } from "bun:test";
import { searchSkills, tokens } from "../src/skill-search";
describe("skill search", () => {
  test("matches skipped name characters and ranks stronger matches first", () => {
    const skill = {
      name: "grill-with-docs",
      description: "Interview a design",
    };
    for (const query of ["grdo", "GRDO", "grilldocs"])
      expect(searchSkills([skill], query)).toEqual([skill]);
    expect(searchSkills([skill], "odrg")).toEqual([]);
    const exact = { name: "grdo", description: "Exact name" };
    const continuous = { name: "grdo-helper", description: "Continuous name" };
    expect(searchSkills([skill, continuous, exact], "grdo")).toEqual([
      exact,
      continuous,
      skill,
    ]);
  });
  test("keeps fuzzy matching on names and uses library quality to rank", () => {
    const compact = { name: "grill-docs", description: "Interview a design" };
    const spaced = {
      name: "grill-with-docs",
      description: "Interview a design",
    };
    const descriptionOnly = {
      name: "research",
      description: "grill-with-docs",
    };
    expect(searchSkills([spaced, compact, descriptionOnly], "grdo")).toEqual([
      compact,
      spaced,
    ]);
    expect(searchSkills([spaced], "grdo unrelated")).toEqual([]);
    expect(searchSkills([descriptionOnly], "grill docs")).toEqual([
      descriptionOnly,
    ]);
  });
  test("matches incomplete joined names across separators", () => {
    const skill = {
      name: "to-orc-impl",
      description: "Delegate implementation",
    };
    for (const query of ["toorc", "to-orc", "ToOrc", "orcimp"])
      expect(searchSkills([skill], query)).toEqual([skill]);
    const exact = { name: "toorc", description: "An exact name" };
    expect(searchSkills([skill, exact], "toorc")[0]).toEqual(exact);
  });
  test("splits punctuation and camel case like orga", () => {
    expect(tokens("HTTPServerAudit git-review")).toEqual([
      "http",
      "server",
      "audit",
      "git",
      "review",
    ]);
    expect(
      searchSkills(
        [
          { name: "http-client", description: "Send requests" },
          {
            name: "HTTPServerAudit",
            description: "Inspect service configuration",
          },
        ],
        "http server",
      ).map((s) => s.name),
    ).toEqual(["HTTPServerAudit", "http-client"]);
  });
  test("ranks coverage and fields like orga, with exact names first", () => {
    const skills = [
      { name: "plan-triage", description: "Triage implementation plans" },
      {
        name: "pr-review-loop",
        description: "Review pull requests in a repeated loop",
      },
      { name: "review-notes", description: "Review collected notes" },
    ];
    expect(
      searchSkills(skills, "review loop triage")
        .slice(0, 2)
        .map((s) => s.name),
    ).toEqual(["pr-review-loop", "plan-triage"]);
    expect(searchSkills(skills, "review notes")[0].name).toBe("review-notes");
  });
  test("matches full descriptions and incomplete names", () => {
    const skills = [
      {
        name: "research",
        description: "Collect current evidence",
      },
      { name: "review-again", description: "Verify previous changes" },
    ];
    expect(searchSkills(skills, "evidence")[0].name).toBe("research");
    expect(searchSkills(skills, "rev")[0].name).toBe("review-again");
    expect(searchSkills(skills, "unrelated")).toEqual([]);
    expect(searchSkills([...skills].reverse(), "").map((s) => s.name)).toEqual(
      searchSkills(skills, "").map((s) => s.name),
    );
  });
});
