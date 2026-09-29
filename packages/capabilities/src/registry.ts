import { descriptorsHash, type CapabilityManifest, type ToolDescriptor } from "./manifest.ts";
import { scanText } from "./scanner.ts";
import type { TrustLevel } from "./trust.ts";

export type CapabilityStatus = "active" | "needs-reapproval";

export interface InstalledCapability {
  manifest: CapabilityManifest;
  trust: TrustLevel;
  status: CapabilityStatus;
  /** Hash of the tool descriptors the user approved. */
  pinnedHash: string;
}

export type VerifyResult = "ok" | "changed";

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export class CapabilityRegistry {
  private readonly items = new Map<string, InstalledCapability>();

  install(manifest: CapabilityManifest, trust: TrustLevel): InstalledCapability {
    if (trust === "blocked") throw new CapabilityError(`"${manifest.id}" is blocked and cannot be installed`);
    if (this.items.has(manifest.id)) throw new CapabilityError(`"${manifest.id}" is already installed`);

    for (const tool of manifest.tools) {
      if (!tool.name.startsWith(`${manifest.id}.`)) {
        throw new CapabilityError(`tool "${tool.name}" must be namespaced "${manifest.id}.<tool>"`);
      }
      if (tool.effects.length === 0) {
        throw new CapabilityError(`tool "${tool.name}" does not declare its effects`);
      }
      const scan = scanText(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? "")}`);
      if (scan.blocked) {
        const first = scan.findings.find((f) => f.severity === "block");
        throw new CapabilityError(`tool "${tool.name}" was blocked by the scanner (${first?.rule})`);
      }
    }

    const installed: InstalledCapability = {
      manifest,
      trust,
      status: "active",
      pinnedHash: descriptorsHash(manifest.tools),
    };
    this.items.set(manifest.id, installed);
    return installed;
  }

  /**
   * Compare what the server advertises now with what was approved. A change
   * (a "rug pull") switches the capability off until the user approves it again.
   */
  verify(id: string, currentTools: readonly ToolDescriptor[]): VerifyResult {
    const item = this.require(id);
    if (descriptorsHash(currentTools) === item.pinnedHash) return "ok";
    item.status = "needs-reapproval";
    return "changed";
  }

  /** The user reviewed the new descriptors: pin them and switch back on. */
  approveChange(id: string, currentTools: readonly ToolDescriptor[]): void {
    const item = this.require(id);
    for (const tool of currentTools) {
      const scan = scanText(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? "")}`);
      if (scan.blocked) throw new CapabilityError(`changed tool "${tool.name}" was blocked by the scanner`);
      if (!tool.name.startsWith(`${id}.`)) throw new CapabilityError(`tool "${tool.name}" is outside namespace "${id}"`);
    }
    item.manifest = { ...item.manifest, tools: currentTools };
    item.pinnedHash = descriptorsHash(currentTools);
    item.status = "active";
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  get(id: string): InstalledCapability | undefined {
    return this.items.get(id);
  }

  list(): InstalledCapability[] {
    return [...this.items.values()];
  }

  /** Tools the model may be offered: only from active capabilities. */
  enabledTools(): ToolDescriptor[] {
    return this.list()
      .filter((c) => c.status === "active")
      .flatMap((c) => [...c.manifest.tools]);
  }

  private require(id: string): InstalledCapability {
    const item = this.items.get(id);
    if (!item) throw new CapabilityError(`"${id}" is not installed`);
    return item;
  }
}
