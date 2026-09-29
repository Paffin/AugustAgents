import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanText, type CapabilityManifest } from "@august/capabilities";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export interface SkippedSkill {
  folder: string;
  reason: string;
}

export const MAX_SKILL_BYTES = 64 * 1024;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

/** Parse a SKILL.md: YAML-style frontmatter with at least name and description, then the instructions. */
export function parseSkill(text: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new SkillError("SKILL.md must start with a --- frontmatter block");
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  const name = fields.name;
  const description = fields.description;
  if (!name || !SKILL_NAME.test(name)) throw new SkillError("skill name must be lowercase letters, digits and dashes");
  if (!description) throw new SkillError("skill needs a description");
  return { name, description, body: m[2]!.trim() };
}

/** Every text a skill feeds the model goes through the scanner; a blocked skill is not loaded. */
export function checkSkill(skill: Skill): void {
  const scan = scanText(`${skill.name}\n${skill.description}\n${skill.body}`);
  if (scan.blocked) throw new SkillError(`blocked by the scanner (${scan.findings.find((f) => f.severity === "block")?.rule})`);
}

export function loadSkills(dir: string): { skills: Skill[]; skipped: SkippedSkill[] } {
  const skills: Skill[] = [];
  const skipped: SkippedSkill[] = [];
  if (!existsSync(dir)) return { skills, skipped };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      if (text.length > MAX_SKILL_BYTES) throw new SkillError("SKILL.md is too large");
      const skill = parseSkill(text);
      checkSkill(skill);
      if (skills.some((s) => s.name === skill.name)) throw new SkillError(`duplicate skill name "${skill.name}"`);
      skills.push(skill);
    } catch (error) {
      skipped.push({ folder: entry.name, reason: (error as Error).message });
    }
  }
  return { skills, skipped };
}

/**
 * Skills become tools named skill.<name>. Calling one returns its
 * instructions. Only read effects: a skill can guide the agent, and every
 * action it suggests still passes the policy.
 */
export function skillsManifest(skills: readonly Skill[]): CapabilityManifest {
  return {
    id: "skill",
    kind: "skill",
    version: "1",
    source: { registry: "local" },
    tools: skills.map((s) => ({
      name: `skill.${s.name}`,
      description: s.description.slice(0, 500),
      effects: ["read"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })),
  };
}

export interface GithubSkillRef {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

/** Accepts https://github.com/<owner>/<repo>/tree/<ref>/<path> (a folder with SKILL.md). */
export function parseGithubSkillUrl(url: string): GithubSkillRef {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:tree|blob)\/([A-Za-z0-9_./-]+?)\/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+?)(?:\/SKILL\.md)?\/?$/.exec(url);
  if (!m) throw new SkillError("use a GitHub folder link like https://github.com/owner/repo/tree/main/skills/name");
  const path = m[4]!;
  if (path.split("/").some((p) => p === "..")) throw new SkillError("invalid path");
  return { owner: m[1]!, repo: m[2]!, ref: m[3]!, path };
}

export async function fetchGithubSkill(url: string, fetchFn: typeof fetch = fetch): Promise<Skill> {
  const r = parseGithubSkillUrl(url);
  const raw = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.ref}/${r.path}/SKILL.md`;
  let response: Response;
  try {
    response = await fetchFn(raw, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new SkillError(`could not download the skill (${(error as Error).name})`);
  }
  if (!response.ok) throw new SkillError(`could not download the skill (HTTP ${response.status})`);
  const text = await response.text();
  if (text.length > MAX_SKILL_BYTES) throw new SkillError("SKILL.md is too large");
  const skill = parseSkill(text);
  checkSkill(skill);
  return skill;
}

/** Write only SKILL.md. Scripts a skill may ship are not installed: they would be code running as you. */
export function writeSkill(dir: string, skill: Skill, source: string): string {
  const folder = join(dir, skill.name);
  if (existsSync(join(folder, "SKILL.md"))) throw new SkillError(`skill "${skill.name}" is already installed`);
  mkdirSync(folder, { recursive: true });
  const text = `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\n/g, " ")}\nsource: ${source}\n---\n\n${skill.body}\n`;
  writeFileSync(join(folder, "SKILL.md"), text);
  return folder;
}
