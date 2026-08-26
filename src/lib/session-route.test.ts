import { describe, expect, it } from "bun:test";
import { decodeSessionRouteSegment, sessionRoute } from "./session-route";

describe("session routes", () => {
  it("round-trips compound IDs with embedded percent escapes exactly once", () => {
    const id = "opencode:ui%2Fone:ses%2Ftab";
    const encoded = sessionRoute(id, "/send").slice("/sessions/".length, -5);
    expect(decodeSessionRouteSegment(encoded)).toBe(id);
  });

  it("round-trips IDs containing decoded slash and backslash", () => {
    for (const id of ["ui/one", "ui\\one", "opencode:ui/one:tab\\two"]) {
      const encoded = sessionRoute(id).slice("/sessions/".length);
      expect(decodeSessionRouteSegment(encoded)).toBe(id);
    }
  });

  it("rejects malformed percent escapes and raw multi-segment routes", () => {
    expect(decodeSessionRouteSegment("%zz")).toBeNull();
    expect(decodeSessionRouteSegment("a/b")).toBeNull();
    expect(decodeSessionRouteSegment("a%2Fb")).toBe("a/b");
    expect(decodeSessionRouteSegment("a%5Cb")).toBe("a\\b");
  });
});
