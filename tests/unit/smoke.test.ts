import { describe, expect, test } from "bun:test";
import { main } from "../../src/server/cli.ts";

describe("bddb cli", () => {
  test("rejects unknown commands", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(await main(["nope"])).toBe(1);
    } finally {
      console.error = originalError;
    }
  });

  test("help exits zero", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await main(["help"])).toBe(0);
      expect(await main(["version"])).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });
});
