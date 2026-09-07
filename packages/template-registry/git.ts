import * as fsp from "node:fs/promises";
import {
  discoverExactGitSnapshot,
  withTemporaryGitCheckout,
  type GitClient,
  type SnapshotContentSink,
} from "@vibestudio/git";
import type { TemplateRegistryAcquirer, AcquiredRegistrySnapshot } from "./client.js";
import type { TemplateRegistrySource } from "./contract.js";

export interface ExactGitRegistryAcquirerOptions {
  git: GitClient;
  checkoutRoot: string;
  sink: SnapshotContentSink;
}

function transportUrl(url: string): string {
  return url.startsWith("git+") ? url.slice(4) : url;
}

export class ExactGitRegistryAcquirer implements TemplateRegistryAcquirer {
  constructor(private readonly options: ExactGitRegistryAcquirerOptions) {}

  async discover(source: TemplateRegistrySource): Promise<AcquiredRegistrySnapshot> {
    return withTemporaryGitCheckout(
      fsp,
      this.options.checkoutRoot,
      "registry-discovery",
      (checkout) =>
        discoverExactGitSnapshot({
          git: this.options.git,
          dir: checkout,
          url: transportUrl(source.url),
          ref: source.ref,
          label: "Vibestudio template registry",
          sink: this.options.sink,
          reservedPaths: "exclude",
        })
    );
  }
}
