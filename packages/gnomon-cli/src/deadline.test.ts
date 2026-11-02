import { describe, it, expect } from "vitest";
import { parseDeadline, formatDeadline } from "./deadline.js";

describe("gnomon task --deadline", () => {
  it("reads seconds, s, m and h", () => {
    expect(parseDeadline("840")).toBe(840_000);
    expect(parseDeadline("840s")).toBe(840_000);
    expect(parseDeadline("14m")).toBe(840_000);
    expect(parseDeadline("1.5h")).toBe(5_400_000);
    expect(parseDeadline(" 15m ")).toBe(900_000);
  });
  it("refuses what it would have to guess", () => {
    for (const bad of ["", "m", "15min", "-5m", "1d", "15 m", "0", "0.5"]) {
      expect(parseDeadline(bad)).toBeUndefined();
    }
  });
  it("writes a deadline back as a person would", () => {
    expect(formatDeadline(840_000)).toBe("14m");
    expect(formatDeadline(3_600_000)).toBe("1h");
    expect(formatDeadline(90_000)).toBe("90s");
  });
});
