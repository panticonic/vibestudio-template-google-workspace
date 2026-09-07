export function documentTitleForPanel(title: string | undefined): string {
  const normalized = title?.trim().replace(/\s+/g, " ").slice(0, 80);
  return normalized || "Terminal";
}
