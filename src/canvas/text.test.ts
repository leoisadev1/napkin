/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { stickySize } from "./text";

const PICK =
  "Pick: an underserved audience because specific unmet needs create a clearer reason to choose you, and a narrow first audience makes onboarding, messaging and the first feature list far easier to get right.";

describe("stickySize", () => {
  test("a short note keeps the classic near-square size and full font", () => {
    const s = stickySize("Habit tracking app — explore a distinctive angle");
    expect(s.w).toBe(200);
    expect(s.fontSize).toBe(20);
    expect(s.h).toBeLessThanOrEqual(s.w);
  });

  test("a long note grows wider before taller, capped at 360, with a smaller font", () => {
    const s = stickySize(PICK);
    expect(s.w).toBeGreaterThan(200);
    expect(s.w).toBeLessThanOrEqual(360);
    // Between 1:1 and 3:2 landscape, never a tall narrow wall.
    expect(s.h).toBeLessThanOrEqual(s.w);
    expect(s.w / s.h).toBeLessThanOrEqual(1.5);
    expect(s.fontSize).toBeLessThan(20);
  });

  test("width grows with length", () => {
    const widths = [40, 90, 160, 200].map((n) => stickySize("word ".repeat(n / 5)).w);
    for (let i = 1; i < widths.length; i++) expect(widths[i] ?? 0).toBeGreaterThanOrEqual(widths[i - 1] ?? 0);
  });
});
