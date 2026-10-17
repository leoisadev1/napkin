/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "../conversation/types";
import { recentSegments } from "./LiveLine";

const user = (id: string, text: string): TranscriptEntry => ({ id, role: "user", text, final: true });

describe("recentSegments", () => {
  test("marks phrases by their pending state, matched by id or text", () => {
    const transcript = [user("t1", "a habit tracker"), user("t2", "with streaks"), user("t3", "and friends")];
    const segments = recentSegments(transcript, [
      { id: "t2", text: "with streaks", status: "drawing" },
      { id: "p9", text: "and friends", status: "queued" },
    ]);
    expect(segments.map((s) => s.status)).toEqual(["drawn", "drawing", "queued"]);
  });

  test("shows heard phrases that are not in the transcript yet", () => {
    const segments = recentSegments([user("t1", "hello")], [{ id: "p1", text: "draw a loop", status: "queued" }]);
    expect(segments.map((s) => s.text)).toEqual(["hello", "draw a loop"]);
  });

  test("stops at the partner's last reply and keeps about a line of words", () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const transcript: TranscriptEntry[] = [user("old", "before"), { id: "a", role: "assistant", text: "ok", final: true }, user("t1", long)];
    const segments = recentSegments(transcript, []);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text.split(" ")).toHaveLength(40);
    expect(segments[0]?.text.endsWith("w59")).toBe(true);
  });
});
