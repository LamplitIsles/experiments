import type { Skill } from "./contracts";

export function tokens(value: string): string[] {
  return (
    value
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}
export function searchSkills(skills: Skill[], query: string): Skill[] {
  const q = tokens(query);
  const unique = [...new Set(q)];
  const ranked = skills
    .map((skill) => {
      const name = tokens(skill.name);
      const description = new Set(tokens(skill.description));
      const names = new Set([...name, name.join("")]);
      const matches = unique.filter((t) => names.has(t) || description.has(t));
      const phrase =
        q.length > 0 &&
        name.some((_, i) => q.every((t, j) => name[i + j] === t));
      const partial = unique.filter((t) => name.some((n) => n.includes(t)));
      return {
        skill,
        rank: [
          Number(name.join(" ") === q.join(" ")),
          Number(phrase),
          matches.length,
          unique.filter((t) => names.has(t)).length,
          unique.filter((t) => description.has(t)).length,
          partial.length,
        ],
        matches: matches.length + partial.length,
      };
    })
    .filter((r) => !q.length || r.matches > 0);
  ranked.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++)
      if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
    return (
      a.skill.name.length - b.skill.name.length ||
      (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0)
    );
  });
  return ranked.map((r) => r.skill);
}
