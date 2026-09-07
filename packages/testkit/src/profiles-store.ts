/**
 * Profile artifact persistence on context fs.
 *
 * Artifacts live under /.testkit/profiles/ as standard V8 .cpuprofile /
 * .heapsnapshot files (speedscope/DevTools-loadable), with an index.json of
 * compact ProfileRefs. Artifacts are never inlined in eval results.
 */
import {
  PROFILES_INDEX_PATH,
  persistProfile,
  profilePath,
  type ProfileRef,
} from "./profile-core.js";
import { fs } from "@workspace/runtime";

export { profilePath };
export type { ProfileRef };

export async function saveProfile(ref: ProfileRef, data: string): Promise<ProfileRef> {
  return persistProfile(fs, ref, data);
}

export async function listProfiles(): Promise<ProfileRef[]> {
  try {
    const raw = (await fs.readFile(PROFILES_INDEX_PATH, "utf8")) as string;
    return JSON.parse(raw) as ProfileRef[];
  } catch {
    return [];
  }
}

export async function readProfile(path: string): Promise<string> {
  return (await fs.readFile(path, "utf8")) as string;
}
