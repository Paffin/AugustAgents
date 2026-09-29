import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanText, type CapabilityManifest } from "@august/capabilities";
import { EFFECTS, widenedEffects, type Effect } from "@august/policy";

/** Where a skill on disk came from, as recorded when August installed it. */
export interface SkillProvenance {
  origin: "github" | "local";
  /** The link the owner approved. Absent for a skill the owner placed by hand. */
  source?: string;
  /** The exact commit the text was fetched at: the branch in the link may move, the commit cannot. */
  commit?: string;
  /** sha256 of SKILL.md as installed. A different file on disk is a modified skill and is not loaded. */
  sha256: string;
  installedAt?: string;
}

export interface Skill {
  name: string;
  description: string;
  body: string;
  /**
   * What the skill's instructions ask the agent to do, declared by its author and shown at install. Default: read only.
   * A new version may not widen this without the owner approving the widening.
   */
  effects: Effect[];
  provenance?: SkillProvenance;
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
  const declared = fields.effects === undefined ? ["read"] : fields.effects.split(/[\s,]+/).filter(Boolean);
  const unknown = declared.filter((e) => !(EFFECTS as readonly string[]).includes(e));
  if (unknown.length || declared.length === 0) throw new SkillError(`skill effects must be from: ${EFFECTS.join(", ")}`);
  return { name, description, body: m[2]!.trim(), effects: [...new Set(declared as Effect[])] };
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
      skill.provenance = readProvenance(join(dir, entry.name), text);
      skills.push(skill);
    } catch (error) {
      skipped.push({ folder: entry.name, reason: (error as Error).message });
    }
  }
  return { skills, skipped };
}

const PROVENANCE_FILE = ".august-provenance.json";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The recorded provenance if the file still matches it; a skill placed by hand has none and is "local". A changed file is refused. */
function readProvenance(folder: string, text: string): SkillProvenance {
  const path = join(folder, PROVENANCE_FILE);
  const actual = sha256(text);
  if (!existsSync(path)) return { origin: "local", sha256: actual };
  let recorded: Partial<SkillProvenance>;
  try {
    recorded = JSON.parse(readFileSync(path, "utf8")) as Partial<SkillProvenance>;
  } catch {
    throw new SkillError("its provenance record is damaged");
  }
  if (recorded.origin !== "github" || typeof recorded.sha256 !== "string" || typeof recorded.source !== "string" || typeof recorded.commit !== "string" || !/^[0-9a-f]{40}$/.test(recorded.commit)) throw new SkillError("its provenance record is invalid");
  if (recorded.sha256 !== actual) throw new SkillError("SKILL.md changed since it was installed");
  return { origin: "github", source: recorded.source, commit: recorded.commit, sha256: actual, installedAt: recorded.installedAt };
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
      description: `${s.description.slice(0, 460)}${s.provenance?.commit ? ` (from ${s.provenance.source?.replace(/^https:\/\/github\.com\//, "")}@${s.provenance.commit.slice(0, 7)})` : ""}`.slice(0, 500),
      effects: ["read"],
      // Instructions written by whoever authored the skill; they guide the model but never authorize an action.
      producesUntrusted: true,
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

/** A skill downloaded from GitHub, at an exact commit. */
export interface FetchedSkill extends Skill {
  source: string;
  commit: string;
}

async function getText(fetchFn: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new SkillError(`could not download the skill (${(error as Error).name})`);
  }
  if (!response.ok) throw new SkillError(`could not download the skill (HTTP ${response.status})`);
  const text = await response.text();
  if (text.length > MAX_SKILL_BYTES) throw new SkillError("SKILL.md is too large");
  return text;
}

/**
 * Resolves the link's branch or tag to one commit, then downloads SKILL.md at that commit, so what the
 * owner previews is the very text that is installed and recorded, even if the branch moves in between.
 */
export async function fetchGithubSkill(url: string, fetchFn: typeof fetch = fetch): Promise<FetchedSkill> {
  const r = parseGithubSkillUrl(url);
  const commit = (await getText(fetchFn, `https://api.github.com/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(r.ref)}`, { accept: "application/vnd.github.sha" })).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new SkillError("GitHub did not return a commit for that link");
  const text = await getText(fetchFn, `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${commit}/${r.path}/SKILL.md`);
  const skill = parseSkill(text);
  checkSkill(skill);
  return { ...skill, source: url, commit };
}

export interface WriteSkillOptions {
  /** The commit the text was fetched at. Recorded so the skill can be traced and verified. */
  commit?: string;
  /** Replace an installed skill of the same name (an upgrade). Without it an existing skill is never overwritten. */
  replace?: boolean;
  now?: () => number;
}

/** What an upgrade would widen: effects the new version declares that the installed one did not. */
export function skillUpgradeWidening(dir: string, next: Skill): Effect[] {
  const file = join(dir, next.name, "SKILL.md");
  if (!existsSync(file)) return [];
  return widenedEffects(parseSkill(readFileSync(file, "utf8")).effects, next.effects);
}

/**
 * Write only SKILL.md and a provenance record next to it. Scripts a skill may ship are not installed: they
 * would be code running as you. The file goes in whole or not at all.
 */
export function writeSkill(dir: string, skill: Skill, source: string, options: WriteSkillOptions = {}): string {
  const folder = join(dir, skill.name);
  if (existsSync(join(folder, "SKILL.md")) && !options.replace) throw new SkillError(`skill "${skill.name}" is already installed`);
  mkdirSync(folder, { recursive: true });
  const text = `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\n/g, " ")}\neffects: ${skill.effects.join(", ")}\nsource: ${source}\n---\n\n${skill.body}\n`;
  const record: SkillProvenance = { origin: "github", source, commit: options.commit ?? "0".repeat(40), sha256: sha256(text), installedAt: new Date((options.now ?? Date.now)()).toISOString() };
  const tmp = join(folder, ".SKILL.md.tmp");
  writeFileSync(tmp, text);
  writeFileSync(join(folder, PROVENANCE_FILE), JSON.stringify(record, null, 2));
  renameSync(tmp, join(folder, "SKILL.md"));
  return folder;
}
