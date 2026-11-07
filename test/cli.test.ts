import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// The --minutes guard must fail closed before the engine starts, so these
// spawns never touch the network.
describe("cli --minutes guard", () => {
  for (const value of ["", "abc", "-5", "--live"]) {
    test(`rejects --minutes ${JSON.stringify(value)}`, () => {
      const result = spawnSync(process.execPath, ["run", "src/index.ts", "scan", "--minutes", value], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--minutes requires a non-negative numeric value");
    });
  }
});
