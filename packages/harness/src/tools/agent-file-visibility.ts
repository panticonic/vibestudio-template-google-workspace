import path from "node:path";
import type { RuntimeFs } from "./runtime-fs.js";
import { decodeUtf8 } from "./portable-bytes.js";

export interface AgentFileVisibility {
  isHidden(absolutePath: string): Promise<boolean>;
  filterVisible<T>(items: readonly T[], pathOf: (item: T) => string): Promise<T[]>;
}

/**
 * Keeps development-only skills out of the model-facing filesystem tools.
 *
 * `agentVisible: false` is one visibility contract, not merely a catalog hint:
 * an agent cannot rediscover the same skill by listing, reading, or searching
 * the source tree. Other callers retain the ordinary workspace filesystem.
 */
export function createAgentFileVisibility(cwd: string, fs: RuntimeFs): AgentFileVisibility {
  const skillsRoot = path.resolve(cwd, "skills");
  let hiddenRootsPromise: Promise<string[]> | null = null;

  const hiddenRoots = (): Promise<string[]> => {
    if (hiddenRootsPromise) return hiddenRootsPromise;
    hiddenRootsPromise = (async () => {
      let entries;
      try {
        entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
        throw error;
      }
      const roots = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry): Promise<string | null> => {
            const root = path.join(skillsRoot, entry.name);
            let source: string | Uint8Array;
            try {
              source = await fs.readFile(path.join(root, "SKILL.md"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
              throw error;
            }
            return hasHiddenAgentFrontmatter(source) ? path.resolve(root) : null;
          })
      );
      return roots.filter((root): root is string => root !== null).sort();
    })();
    return hiddenRootsPromise;
  };

  const isHidden = async (absolutePath: string): Promise<boolean> => {
    const resolved = path.resolve(absolutePath);
    return (await hiddenRoots()).some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
    );
  };

  return {
    isHidden,
    async filterVisible<T>(items: readonly T[], pathOf: (item: T) => string): Promise<T[]> {
      const visibility = await Promise.all(
        items.map(async (item) => ({ item, hidden: await isHidden(pathOf(item)) }))
      );
      return visibility.filter(({ hidden }) => !hidden).map(({ item }) => item);
    },
  };
}

function hasHiddenAgentFrontmatter(source: string | Uint8Array): boolean {
  const text = typeof source === "string" ? source : decodeUtf8(source);
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  return Boolean(frontmatter && /^agentVisible\s*:\s*false\s*(?:#.*)?$/imu.test(frontmatter));
}
