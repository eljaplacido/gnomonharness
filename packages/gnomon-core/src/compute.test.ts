/**
 * Deterministic arithmetic.
 *
 * The point of the tool is that a model does not have to be trusted with a
 * number, so these pin the cases where trusting it — or trusting floating
 * point — gives the wrong one.
 */
import { describe, it, expect } from "vitest";
import { compute, ComputeError } from "./compute.js";

describe("compute — exact decimal arithmetic", () => {
  it("does not answer in floating point", () => {
    // The canonical wrong answer is 0.30000000000000004.
    expect(compute("0.1 + 0.2")).toBe("0.3");
    // A money answer that is off by a cent is the kind that survives review.
    expect(compute("19.99 * 3")).toBe("59.97");
    expect(compute("0.1 * 3")).toBe("0.3");
  });

  it("is exact past what a double can hold", () => {
    expect(compute("123456789012345678901234567890 * 2")).toBe(
      "246913578024691357802469135780"
    );
    expect(compute("2 ^ 64")).toBe("18446744073709551616");
  });

  it("normalises trailing zeros", () => {
    expect(compute("1.50 + 0.50")).toBe("2");
    expect(compute("2.500 * 2")).toBe("5");
  });

  it("follows precedence and associativity", () => {
    expect(compute("(2+3)*4 - 10 % 3")).toBe("19");
    expect(compute("2 + 3 * 4")).toBe("14");
    expect(compute("100 / 5 / 2")).toBe("10");
  });

  it("has the functions an answer usually needs", () => {
    expect(compute("sqrt(16)")).toBe("4");
    expect(compute("round(2.5)")).toBe("3");
    expect(compute("round(1.23456, 2)")).toBe("1.23");
    expect(compute("floor(-1.5)")).toBe("-2");
    expect(compute("ceil(-1.5)")).toBe("-1");
    expect(compute("abs(-7)")).toBe("7");
    expect(compute("min(3, 1, 2)")).toBe("1");
    expect(compute("max(3, 1, 2)")).toBe("3");
  });

  it("groups digits with `_`, and refuses `,` as ambiguous", () => {
    expect(compute("1_000_000 * 3")).toBe("3000000");
    // `,` already separates arguments: min(1,234) has no unambiguous reading,
    // so a comma inside a number is refused rather than guessed at.
    expect(compute("min(1,234)")).toBe("1");
    expect(() => compute("1,234 + 1")).toThrow(ComputeError);
  });

  it("is a parser, not an evaluator — no code runs", () => {
    // The expression is model-authored text from an inference endpoint. If
    // this reached eval() every arithmetic question would be an RCE.
    for (const src of [
      "process.exit(1)",
      "require('fs')",
      "globalThis",
      "1; console.log(2)",
      "constructor",
    ]) {
      expect(() => compute(src)).toThrow(ComputeError);
    }
  });

  it("refuses with a reason the model can act on", () => {
    expect(() => compute("1/0")).toThrow(/division by zero/);
    expect(() => compute("1 +")).toThrow(/ended early/);
    expect(() => compute("foo(2)")).toThrow(/unknown name/);
    expect(() => compute("")).toThrow(/empty/);
    expect(() => compute("2 ^ 0.5")).toThrow(/whole number/);
    expect(() => compute("(1 + 2")).toThrow(/closing parenthesis/);
  });

  it("is deterministic — the same expression always gives the same string", () => {
    // The whole harness rests on this: an answer that varied between runs
    // would make a recorded session unreproducible.
    for (const e of ["1/3", "sqrt(2)", "22/7"]) {
      expect(compute(e)).toBe(compute(e));
    }
  });

  it("bounds the work it will do", () => {
    expect(() => compute("2 ^ 999999")).toThrow(/too large/);
    expect(() => compute("1 + ".repeat(2000) + "1")).toThrow();
  });
});
