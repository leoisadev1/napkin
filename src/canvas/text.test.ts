/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { stickySize } from "./text";

const PICK = "Pick: Sintra — palaces beat a crowded beach in October";
const LONG =
  "An underserved audience, because specific unmet needs create a clearer reason to choose you, and a narrow first audience makes onboarding, messaging and the first feature list far easier to get right.";

describe("stickySize", () => {
  test("a short note is a landscape card at the shared font size", () => {
    const s = stickySize("Book Sintra tickets early");
    expect(s.w).toBe(220);
    expect(s.fontSize).toBe(18);
    expect(s.h).toBeLessThan(s.w);
  });

  test("a Pick is a wide callout of at most two lines", () => {
    const s = stickySize(PICK);
    expect(s.w).toBeGreaterThan(300);
    expect(s.w).toBeLessThanOrEqual(440);
    expect(s.w / s.h).toBeGreaterThanOrEqual(2.5);
  });

  test("a long note grows wider before taller, capped at 400, never a tall wall", () => {
    const s = stickySize(LONG);
    expect(s.w).toBeLessThanOrEqual(400);
    expect(s.h).toBeLessThanOrEqual(s.w);
    expect(s.fontSize).toBe(18);
  });

  test("width grows with length", () => {
    const widths = [40, 90, 160, 200].map((n) => stickySize("word ".repeat(n / 5)).w);
    for (let i = 1; i < widths.length; i++) expect(widths[i] ?? 0).toBeGreaterThanOrEqual(widths[i - 1] ?? 0);
  });
});
