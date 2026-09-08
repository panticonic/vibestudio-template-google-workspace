import {
  templatesMethods,
  workspaceTemplateSourceMethods,
  type TemplatesClient,
} from "@vibestudio/service-schemas/templates";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

/** The same schema owns inspection and authoring signatures on every runtime. */
export type TemplateManagementClient = TemplatesClient;
export function createTemplateManagementClient(
  invoke: (
    extension: string,
    method: string,
    args: unknown[],
  ) => Promise<unknown>,
): TemplateManagementClient {
  return createTypedServiceClient(
    "templates",
    templatesMethods,
    (_service, method, args) =>
      invoke("@workspace-extensions/templates", method, args),
  );
}

/**
 * Trusted shell composition: moving URLs resolve in the extension, while every
 * exact pin is inspected by the host's single acquisition owner.
 */
export function createShellTemplateManagementClient(
  invoke: (
    extension: string,
    method: string,
    args: unknown[],
  ) => Promise<unknown>,
  callHost: (
    service: string,
    method: string,
    args: unknown[],
  ) => Promise<unknown>,
): TemplateManagementClient {
  const extension = createTemplateManagementClient(invoke);
  const exact = createTypedServiceClient(
    "workspaceTemplateSource",
    workspaceTemplateSourceMethods,
    callHost,
  );
  return {
    ...extension,
    async inspect(locator) {
      const pin =
        "pin" in locator ? locator.pin : await extension.resolveSource(locator);
      return exact.inspectExact(pin);
    },
  };
}

/** Ordinary source addresses; inspection resolves and reviews their exact contents. */
export const workspaceExamples = [
  {
    name: "Examples",
    description: "Explore sample panels, agents and tools.",
    url: "https://github.com/panticonic/vibestudio-template-examples",
  },
  {
    name: "Google Workspace",
    description: "Connect Google Workspace and work with a Gmail agent.",
    url: "https://github.com/panticonic/vibestudio-template-google-workspace",
  },
  {
    name: "News",
    description: "Collect feeds and brief the news.",
    url: "https://github.com/panticonic/vibestudio-template-news",
  },
  {
    name: "Spectrolite",
    description: "Write and edit MDX with collaborative agents.",
    url: "https://github.com/panticonic/vibestudio-template-spectrolite",
  },
] as const;
