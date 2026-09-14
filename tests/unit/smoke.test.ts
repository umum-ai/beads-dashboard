import { describe, expect, test } from "bun:test";
import { main } from "../../src/server/cli.ts";

describe("bddb skeleton", () => {
  test("cli rejects unknown commands", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(main(["nope"])).toBe(1);
    } finally {
      console.error = originalError;
    }
  });

  test("cli help exits zero", () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(main(["help"])).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });
});
