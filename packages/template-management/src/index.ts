import { templatesMethods, type TemplatesClient } from "@vibestudio/service-schemas/templates";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

/** The same schema owns inspection, catalog and authoring signatures on every runtime. */
export type TemplateManagementClient = TemplatesClient;
export function createTemplateManagementClient(
  invoke: (extension: string, method: string, args: unknown[]) => Promise<unknown>,
): TemplateManagementClient {
  return createTypedServiceClient("templates", templatesMethods,
    (_service, method, args) => invoke("@workspace-extensions/templates", method, args));
}
