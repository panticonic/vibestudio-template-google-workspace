#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceSpecifier =
  process.env["PI_AI_CATALOG_MODULE"]?.trim() ||
  "@earendil-works/pi-ai/providers/all";
const { getBuiltinModels, getBuiltinProviders } = await import(sourceSpecifier);
const sourceUrl = import.meta.resolve(sourceSpecifier);
const sourcePackageUrl = new URL("../../package.json", sourceUrl);
const sourcePackage = JSON.parse(await readFile(sourcePackageUrl, "utf8"));

const providers = Object.fromEntries(
  getBuiltinProviders()
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => [
      provider,
      getBuiltinModels(provider)
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id)),
    ]),
);

const output = {
  generatedFrom: `@earendil-works/pi-ai@${sourcePackage.version}`,
  providers,
};
const outputUrl = new URL(
  "../src/builtinCatalog.generated.json",
  import.meta.url,
);
await writeFile(
  fileURLToPath(outputUrl),
  `${JSON.stringify(output, null, 2)}\n`,
);

const modelCount = Object.values(providers).reduce(
  (total, models) => total + models.length,
  0,
);
console.log(
  `Generated ${Object.keys(providers).length} providers and ${modelCount} models`,
);
