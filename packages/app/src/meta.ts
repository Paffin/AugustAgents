import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolCallContext, ToolExecutor, ToolResult } from "@august/agent";
import type { CapabilityManifest, CapabilityRegistry } from "@august/capabilities";
import {
  ArtifactError,
  RegistryClient,
  describeEvidence,
  fetchGithubSkill,
  skillUpgradeWidening,
  loadSkills,
  planInstall,
  skillsManifest,
  writeSkill,
  type ArtifactEvidence,
  type InstallPlan,
  type InstalledArtifact,
  type PackageRef,
  type FetchedSkill,
  type Skill,
} from "@august/discovery";
import type { McpServerConfig } from "./config.ts";

export const metaManifest: CapabilityManifest = {
  id: "august",
  kind: "builtin",
  version: "1",
  source: { registry: "builtin" },
  tools: [
    {
      name: "august.find_tools",
      description: "search the public MCP registry for a new tool or integration the agent does not have yet",
      keywords: ["install", "integration", "connect", "plugin", "найти", "подключить", "установить", "интеграция"],
      effects: ["read", "network"],
      // Registry descriptions are written by strangers.
      producesUntrusted: true,
      inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 100 } }, required: ["query"], additionalProperties: false },
    },
    {
      name: "august.install_tool",
      description: "install an MCP server found with august.find_tools, by its registry name",
      keywords: ["install", "setup", "установить"],
      effects: ["read", "write", "network", "exec"],
      inputSchema: { type: "object", properties: { name: { type: "string", minLength: 3, maxLength: 200 } }, required: ["name"], additionalProperties: false },
    },
    {
      name: "august.install_skill",
      description: "install a skill (SKILL.md instructions) from a GitHub folder link",
      keywords: ["skill", "навык", "install", "установить"],
      effects: ["read", "write", "network"],
      inputSchema: { type: "object", properties: { url: { type: "string", pattern: "^https://github\\.com/" } }, required: ["url"], additionalProperties: false },
    },
  ],
};

/** Fetches and installs the exact package an install plan names, and reports what it verified. */
export interface ArtifactService {
  resolve(ref: PackageRef): Promise<ArtifactEvidence>;
  install(evidence: ArtifactEvidence, id: string): Promise<InstalledArtifact>;
}

export interface MetaExecutorOptions {
  /** Required to install a local package. */
  artifacts?: ArtifactService;
  /** Whether this machine can contain a community program (a working sandbox). Checked before anything is downloaded. */
  containment?(): { ok: true } | { ok: false; reason: string };
  registry: CapabilityRegistry;
  registryClient: RegistryClient;
  skillsDir: string;
  /** Ids already used by configured servers and capabilities. */
  takenIds(): Set<string>;
  /** Start and persist a planned server. Returns a line for the model. */
  addServer(entry: McpServerConfig, plan: InstallPlan): Promise<string>;
  fallback: ToolExecutor;
  fetch?: typeof fetch;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** The agent's own tools: find and install capabilities, and serve installed skills. */
export class MetaExecutor implements ToolExecutor {
  private skills = new Map<string, Skill>();
  private readonly plans = new Map<string, InstallPlan>();
  /** Registry evidence per plan, resolved once for the approval preview and reused by the install, so what is approved is what is installed. */
  private readonly evidence = new Map<string, Promise<ArtifactEvidence>>();
  private readonly skillPreviews = new Map<string, FetchedSkill>();

  constructor(private readonly o: MetaExecutorOptions) {}

  /** (Re)load skills from disk and publish them as the skill.* capability. */
  reloadSkills(): { loaded: string[]; skipped: Array<{ folder: string; reason: string }> } {
    const { skills, skipped } = loadSkills(this.o.skillsDir);
    this.skills = new Map(skills.map((s) => [s.name, s]));
    if (this.o.registry.get("skill")) this.o.registry.remove("skill");
    if (skills.length) this.o.registry.install(skillsManifest(skills), "self-made");
    return { loaded: skills.map((s) => s.name), skipped };
  }

  async describeCall(tool: string, args: Record<string, unknown>): Promise<string | undefined> {
    try {
      if (tool === "august.install_tool") {
        const name = String(args.name);
        const plan = this.plans.get(name);
        if (!plan) return `cannot install: "${name}" has no prepared plan; search with august.find_tools first`;
        const secrets = plan.secrets.length ? `; needs secrets: ${plan.secrets.map((s) => s.name).join(", ")}` : "";
        if (plan.server.package) {
          const evidence = await this.evidenceFor(plan);
          this.requireInstallable(plan, evidence);
          return `install ${plan.registryName}@${plan.version}: ${describeEvidence(evidence)}. Runs sandboxed with no network until you allow hosts (august mcp allow ${plan.server.id} HOST)${secrets}`;
        }
        return `install ${plan.registryName}@${plan.version}: ${plan.summary} (trust: community; your secrets stay in your process)${secrets}`;
      }
      if (tool === "august.install_skill") {
        const skill = await this.previewSkill(String(args.url));
        const widened = skillUpgradeWidening(this.o.skillsDir, skill);
        const upgrade = this.isInstalled(skill.name) ? `; REPLACES the installed "${skill.name}"${widened.length ? ` and ADDS effects it did not declare before: ${widened.join(", ")}` : ", with no wider effects"}` : "";
        return `install skill "${skill.name}": ${clip(skill.description, 200)} (declares effects: ${skill.effects.join(", ")}; from ${skill.source.replace(/^https:\/\/github\.com\//, "")} at commit ${skill.commit.slice(0, 7)}; only SKILL.md, no scripts; its instructions are untrusted text that can guide but never authorize an action)${upgrade}`;
      }
    } catch (error) {
      return `cannot install: ${(error as Error).message}`;
    }
    return this.o.fallback.describeCall?.(tool, args);
  }

  async call(tool: string, args: Record<string, unknown>, context?: ToolCallContext): Promise<ToolResult> {
    try {
      switch (tool) {
        case "august.find_tools":
          return await this.find(String(args.query));
        case "august.install_tool": {
          const name = String(args.name);
          const plan = this.plans.get(name);
          if (!plan) return { content: `"${name}" has no prepared plan; search with august.find_tools first`, isError: true, outcome: "not_sent" };
          // Take before the first await: only one concurrent caller can consume
          // the exact plan that was rendered in the approval preview.
          this.plans.delete(name);
          return { content: await this.o.addServer(await this.entryFor(plan), plan) };
        }
        case "august.install_skill": {
          const url = String(args.url);
          const skill = await this.previewSkill(url);
          this.skillPreviews.delete(url);
          writeSkill(this.o.skillsDir, skill, url, { commit: skill.commit, replace: this.isInstalled(skill.name) });
          this.reloadSkills();
          return { content: `Installed skill "${skill.name}". Its tool is skill.${skill.name}.` };
        }
      }
      if (tool.startsWith("skill.")) {
        const skill = this.skills.get(tool.slice(6));
        if (!skill) return { content: `unknown skill ${tool}`, isError: true };
        const text = `Instructions of skill "${skill.name}":\n${skill.body}`;
        return { content: text, parts: [{ text, origin: { kind: "skill", source: tool, locator: skill.name }, trust: "untrusted", sensitivity: "public" }] };
      }
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
    return this.o.fallback.call(tool, args, context);
  }

  private evidenceFor(plan: InstallPlan): Promise<ArtifactEvidence> {
    if (!this.o.artifacts) throw new Error("this build cannot install packages");
    let pending = this.evidence.get(plan.registryName);
    if (!pending) { pending = this.o.artifacts.resolve(plan.server.package!); this.evidence.set(plan.registryName, pending); pending.catch(() => this.evidence.delete(plan.registryName)); }
    return pending;
  }

  /** Refuses what August will not install before it downloads anything: no sandbox, or no registry signature. */
  private requireInstallable(plan: InstallPlan, evidence: ArtifactEvidence): void {
    const containment = this.o.containment?.();
    if (containment && !containment.ok) throw new ArtifactError(`"${plan.registryName}" is community code and needs a sandbox: ${containment.reason}`);
    if (evidence.signature !== "npm-registry-ecdsa") throw new ArtifactError(`"${plan.registryName}@${plan.version}" is not signed by the package registry, so August will not install it`);
  }

  /** The config entry for a plan. A package becomes an artifact pin only after the install has verified it. */
  private async entryFor(plan: InstallPlan): Promise<McpServerConfig> {
    const { package: pkg, ...rest } = plan.server;
    if (!pkg) return rest as McpServerConfig;
    const evidence = await this.evidenceFor(plan);
    this.requireInstallable(plan, evidence);
    const pin = await this.o.artifacts!.install(evidence, plan.server.id);
    return { ...rest, artifact: pin } as McpServerConfig;
  }

  private async find(query: string): Promise<ToolResult> {
    const hits = await this.o.registryClient.search(query, 8);
    if (!hits.length) return { content: `No MCP servers found for "${query}".` };
    const taken = this.o.takenIds();
    const lines = hits.map((s) => {
      let how: string;
      let version = s.version;
      try {
        // Keep the first unconsumed plan immutable while an approval may be
        // pending, even when a later Registry response changes.
        const p = this.plans.get(s.name) ?? planInstall(s, taken);
        if (!this.plans.has(s.name)) this.plans.set(s.name, p);
        version = p.version;
        how = p.summary + (p.secrets.length ? `; needs ${p.secrets.map((x) => x.name).join(", ")}` : "");
      } catch (error) {
        how = `cannot install: ${(error as Error).message}`;
      }
      return `- ${s.name}@${version}: ${clip(s.description, 200)} [${how}]`;
    });
    return { content: `Found (install with august.install_tool and the exact name):\n${lines.join("\n")}` };
  }

  /** On disk, not just loaded: a skill that was modified and stopped loading is still installed and can be replaced. */
  private isInstalled(name: string): boolean {
    return existsSync(join(this.o.skillsDir, name, "SKILL.md"));
  }

  private async previewSkill(url: string): Promise<FetchedSkill> {
    const cached = this.skillPreviews.get(url);
    if (cached) return cached;
    const skill = await fetchGithubSkill(url, this.o.fetch);
    this.skillPreviews.set(url, skill);
    return skill;
  }
}
