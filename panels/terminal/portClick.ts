import { notifications, openExternal, openPanel } from "@workspace/runtime";
import { normalizeLocalhostUrl } from "./urlUtils.js";

export async function openPort(port: number, urls: string[] = []): Promise<void> {
  const url = normalizeLocalhostUrl(urls.find((item) => urlUsesPort(item, port)) ?? `http://localhost:${port}`);
  await openUrl(url);
}

export async function openUrl(url: string): Promise<void> {
  try {
    await openPanel(url, { focus: true });
    return;
  } catch {
    // Fall through to OS browser.
  }
  try {
    await openExternal(url);
    return;
  } catch {
    await navigator.clipboard.writeText(url);
    await notifications.show({ type: "warning", title: "URL copied", message: "No browser panel was available.", ttl: 2500 });
  }
}

function urlUsesPort(value: string, port: number): boolean {
  try {
    return new URL(value).port === String(port);
  } catch {
    return false;
  }
}
