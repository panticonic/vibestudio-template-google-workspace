function isIpv4Hostname(hostname: string): boolean {
  return (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) &&
    hostname.split(".").every((part) => Number(part) <= 255)
  );
}

function isIpHostname(hostname: string): boolean {
  return isIpv4Hostname(hostname) || (hostname.startsWith("[") && hostname.endsWith("]"));
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isAddressHostname(hostname: string): boolean {
  if (isLocalHostname(hostname) || isIpHostname(hostname)) return true;
  return hostname.includes(".") && !hostname.startsWith(".") && !hostname.endsWith(".");
}

/**
 * Turn address-bar-like input into an HTTP(S) URL.
 *
 * Deliberately ambiguous prose and single words return null so the launcher
 * can preserve its primary chat behavior. Local development addresses default
 * to HTTP; public-looking hostnames default to HTTPS.
 */
export function browserUrlFromEntry(input: string): string | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;

  const hasHttpProtocol = /^https?:\/\//i.test(value);
  const address = value.startsWith("//") ? value.slice(2) : value;
  const addressHostname = address.startsWith("[")
    ? address.slice(0, address.indexOf("]") + 1)
    : address.split(/[:/?#]/, 1)[0]!;
  const provisional = hasHttpProtocol
    ? value
    : `${isLocalHostname(addressHostname.toLowerCase()) || isIpHostname(addressHostname) ? "http" : "https"}://${address}`;

  try {
    const url = new URL(provisional);
    if (!url.hostname || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
    if (!hasHttpProtocol && (url.username || url.password || !isAddressHostname(url.hostname))) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
