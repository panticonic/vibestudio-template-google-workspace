import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseTemplateRegistry, parseTemplateRegistryCoordinates } from "./contract.js";
import type { TemplateRegistryCache, TemplateRegistryCacheRecord } from "./client.js";

export class FileTemplateRegistryCache implements TemplateRegistryCache {
  constructor(private readonly file: string) {}

  async read(): Promise<TemplateRegistryCacheRecord | null> {
    let value: unknown;
    try {
      value = JSON.parse(await fsp.readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Template registry cache must be an object");
    }
    const record = value as Record<string, unknown>;
    if (record["version"] !== 1 || typeof record["verifiedAt"] !== "string") {
      throw new Error("Unsupported template registry cache");
    }
    return {
      version: 1,
      coordinates: parseTemplateRegistryCoordinates(record["coordinates"]),
      registry: parseTemplateRegistry(record["registry"]),
      verifiedAt: record["verifiedAt"],
    };
  }

  async write(record: TemplateRegistryCacheRecord): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, this.file);
  }
}
