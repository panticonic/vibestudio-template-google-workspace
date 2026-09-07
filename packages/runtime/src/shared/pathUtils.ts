/**
 * Cross-platform path utilities for Vibestudio.
 * Works in both Node.js and browser (via pathe shim) environments.
 */

/**
 * Normalize path to use forward slashes.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Extract filename from path.
 */
export function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Resolve a relative path against a base path.
 * This is a simple implementation for browser/panel contexts.
 * For full path resolution with .. handling, use Node.js path module.
 */
export function resolvePath(basePath: string, relativePath: string): string {
  if (relativePath.startsWith("/")) {
    return relativePath;
  }
  const base = basePath.endsWith("/") ? basePath : basePath + "/";
  return base + relativePath;
}
