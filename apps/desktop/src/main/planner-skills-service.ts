import { readFile, readdir } from "node:fs/promises";

type PlannerSkill = {
  name: string;
  instructions: string;
};

const SKILL_MENTION_RE = /\$([a-z0-9][a-z0-9-_]*)/gi;

function plannerSkillsDirUrl(): URL {
  return new URL("../../planner-skills/", import.meta.url);
}

function normalizeSkillName(input: string): string {
  return input.trim().toLowerCase();
}

async function loadSkillByName(name: string): Promise<PlannerSkill | null> {
  const normalized = normalizeSkillName(name);
  const entries = await readdir(plannerSkillsDirUrl(), { withFileTypes: true });
  const match = entries.find(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      normalizeSkillName(entry.name.replace(/\.md$/i, "")) === normalized
  );

  if (!match) {
    return null;
  }

  const instructions = (await readFile(
    new URL(match.name, plannerSkillsDirUrl()),
    "utf8"
  )).trim();
  if (instructions.length === 0) {
    return null;
  }

  return {
    name: normalized,
    instructions
  };
}

export async function loadPlannerSkillsForPrompt(
  prompt: string
): Promise<PlannerSkill[]> {
  const requested = new Set<string>();
  for (const match of prompt.matchAll(SKILL_MENTION_RE)) {
    const name = match[1]?.trim().toLowerCase();
    if (name) {
      requested.add(name);
    }
  }

  if (requested.size === 0) {
    return [];
  }

  const loaded = await Promise.all(
    [...requested].map(async (name) => loadSkillByName(name))
  );
  return loaded.filter((skill): skill is PlannerSkill => skill !== null);
}
