import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UNIT_ROOTS = ["about", "panels", "workers", "apps", "extensions"] as const;
const MOBILE_SOURCE_ROOT = path.join(REPO_ROOT, "apps/mobile/src");
const MOBILE_ICON_REGISTRY = path.join(MOBILE_SOURCE_ROOT, "design/icons.tsx");

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(target);
    } else if (/\.[cm]?[jt]sx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield target;
    }
  }
}

describe("built-in workspace unit icons", () => {
  it("gives every user-visible or executable unit one canonical semantic icon", () => {
    const missing: string[] = [];
    const invalid: string[] = [];

    for (const unitRoot of UNIT_ROOTS) {
      const root = path.join(REPO_ROOT, unitRoot);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(root, entry.name, "package.json");
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          vibestudio?: { icon?: unknown; agent?: { icon?: unknown } };
        };
        const icon = manifest.vibestudio?.icon;
        const label = path.relative(REPO_ROOT, manifestPath);
        if (typeof icon !== "string" || !icon.trim()) {
          missing.push(label);
          continue;
        }
        if (manifest.vibestudio?.agent?.icon !== undefined) {
          invalid.push(`${label}: duplicates vibestudio.icon inside vibestudio.agent`);
        }
        if (icon.startsWith("./")) {
          const iconPath = path.resolve(path.dirname(manifestPath), icon);
          const unitDir = `${path.dirname(manifestPath)}${path.sep}`;
          if (!iconPath.startsWith(unitDir) || !fs.existsSync(iconPath)) {
            invalid.push(`${label}: image icon does not resolve inside the unit`);
          } else if (fs.statSync(iconPath).size > 1024 * 1024) {
            invalid.push(`${label}: image icon exceeds 1 MiB`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it("keeps native Lucide imports inside the tree-shakeable mobile registry", () => {
    const bypasses = [...sourceFiles(MOBILE_SOURCE_ROOT)]
      .filter((file) => file !== MOBILE_ICON_REGISTRY)
      .filter((file) => fs.readFileSync(file, "utf8").includes("lucide-react-native"))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(bypasses).toEqual([]);

    const registry = fs.readFileSync(MOBILE_ICON_REGISTRY, "utf8");
    const packageReferences = [...registry.matchAll(/["'](lucide-react-native[^"']*)["']/gu)].map(
      ([, specifier]) => specifier
    );
    const literalPerIconRequires = [
      ...registry.matchAll(/require\(["'](lucide-react-native\/icons\/[a-z0-9-]+)["']\)/gu),
    ].map(([, specifier]) => specifier);

    expect(packageReferences.length).toBeGreaterThan(0);
    expect(packageReferences).toEqual(literalPerIconRequires);
  });
});
