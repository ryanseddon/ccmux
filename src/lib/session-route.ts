export function sessionRoute(id: string, suffix = ""): string {
  return `/sessions/${encodeURIComponent(id)}${suffix}`;
}

export function decodeSessionRouteSegment(raw: string): string | null {
  if (!raw || raw.includes("/")) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
