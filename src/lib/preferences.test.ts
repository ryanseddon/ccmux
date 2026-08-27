import { describe, expect, it } from "bun:test";
import { DEFAULT_GROUP_BY, VALID_GROUP_BY, type GroupBy } from "./preferences";

describe("grouping preferences", () => {
  it("exposes worktree as a valid mode after project", () => {
    const configured: GroupBy = "worktree";
    expect(VALID_GROUP_BY).toEqual([
      DEFAULT_GROUP_BY,
      configured,
      "cwd",
      "session",
      "window",
      "none",
    ]);
  });
});
