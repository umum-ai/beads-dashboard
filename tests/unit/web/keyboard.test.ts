import { describe, expect, test } from "bun:test";
import {
  findCard,
  isEditableTarget,
  moveFocus,
  resolveShortcut,
} from "../../../src/web/lib/keyboard.ts";

describe("resolveShortcut", () => {
  test("letters fire outside fields without modifiers", () => {
    expect(resolveShortcut({ key: "/" }, false)).toBe("focusSearch");
    expect(resolveShortcut({ key: "n" }, false)).toBe("newIssue");
    expect(resolveShortcut({ key: "?", shiftKey: true }, false)).toBe("help");
    expect(resolveShortcut({ key: "x" }, false)).toBeNull();
  });
  test("fields and modifiers swallow them, Escape always passes", () => {
    expect(resolveShortcut({ key: "/" }, true)).toBeNull();
    expect(resolveShortcut({ key: "n", ctrlKey: true }, false)).toBeNull();
    expect(resolveShortcut({ key: "n", metaKey: true }, false)).toBeNull();
    expect(resolveShortcut({ key: "N", shiftKey: true }, false)).toBeNull();
    expect(resolveShortcut({ key: "Escape" }, true)).toBe("escape");
  });
  test("isEditableTarget", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "ARTICLE" })).toBe(false);
  });
});

describe("moveFocus", () => {
  const columns = [["a1", "a2", "a3"], [], ["c1"], ["d1", "d2"]];

  test("finds cards", () => {
    expect(findCard(columns, "c1")).toEqual({ column: 2, row: 0 });
    expect(findCard(columns, "zz")).toBeNull();
  });
  test("up/down clamp inside the column", () => {
    expect(moveFocus(columns, "a1", "ArrowDown")).toBe("a2");
    expect(moveFocus(columns, "a3", "ArrowDown")).toBeNull();
    expect(moveFocus(columns, "a2", "ArrowUp")).toBe("a1");
    expect(moveFocus(columns, "a1", "ArrowUp")).toBeNull();
    expect(moveFocus(columns, "a2", "Home")).toBe("a1");
    expect(moveFocus(columns, "a1", "End")).toBe("a3");
  });
  test("left/right skip empty columns and keep the row, clamped", () => {
    expect(moveFocus(columns, "a3", "ArrowRight")).toBe("c1");
    expect(moveFocus(columns, "c1", "ArrowRight")).toBe("d1");
    expect(moveFocus(columns, "d2", "ArrowLeft")).toBe("c1");
    expect(moveFocus(columns, "c1", "ArrowLeft")).toBe("a1");
    expect(moveFocus(columns, "d2", "ArrowRight")).toBeNull();
    expect(moveFocus(columns, "a1", "ArrowLeft")).toBeNull();
  });
  test("other keys and unknown cards are ignored", () => {
    expect(moveFocus(columns, "a1", "Enter")).toBeNull();
    expect(moveFocus(columns, "nope", "ArrowDown")).toBeNull();
  });
});
