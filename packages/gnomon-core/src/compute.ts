/**
 * gnomon-core: deterministic arithmetic
 *
 * A model asked for a number will produce one whether or not it computed it.
 * That is the single most reliable way for a confident-sounding answer to be
 * wrong, and no amount of prompting fixes it — so the harness offers a tool
 * that does the arithmetic and instructs the model to use it.
 *
 * Two constraints shape the implementation, and both rule out the obvious
 * approaches:
 *
 *   * No `eval`, no `Function`. The input is model-authored text arriving from
 *     an inference endpoint; handing it to a JavaScript evaluator makes every
 *     arithmetic question a remote code execution primitive.
 *   * No shelling out to `python3 -c` or `bc`. Rule 1 forbids machine-scoped
 *     configuration, and "whichever interpreter this machine happens to have"
 *     is exactly that: the same expression would answer differently on two
 *     checkouts, or fail on one of them.
 *
 * So: a small recursive-descent parser over exact decimal arithmetic. Values
 * are scaled BigInts, which is what makes `0.1 + 0.2` return `0.3` rather than
 * `0.30000000000000004` — a float answer to a money question is the kind of
 * wrong that survives review.
 */

/** A decimal: `unscaled * 10^-scale`. `1.25` is `{ unscaled: 125n, scale: 2 }`. */
interface Dec {
  unscaled: bigint;
  scale: number;
}

/** Digits kept for a division that does not terminate. */
const DIV_PRECISION = 30;

function dec(unscaled: bigint, scale: number): Dec {
  return { unscaled, scale };
}

/** Raise both operands to a common scale so they can be added or compared. */
function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.unscaled * 10n ** BigInt(scale - a.scale),
    b.unscaled * 10n ** BigInt(scale - b.scale),
    scale,
  ];
}

/** Drop trailing zeros, so `1.50 + 0.50` prints `2` rather than `2.00`. */
function normalise(d: Dec): Dec {
  let { unscaled, scale } = d;
  while (scale > 0 && unscaled % 10n === 0n) {
    unscaled /= 10n;
    scale--;
  }
  return dec(unscaled, scale);
}

function add(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalise(dec(x + y, s));
}

function sub(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return normalise(dec(x - y, s));
}

function mul(a: Dec, b: Dec): Dec {
  return normalise(dec(a.unscaled * b.unscaled, a.scale + b.scale));
}

function div(a: Dec, b: Dec): Dec {
  if (b.unscaled === 0n) throw new ComputeError("division by zero");
  // Scale the numerator up by the precision we intend to keep, then round
  // half-away-from-zero on the discarded digit.
  const shift = BigInt(DIV_PRECISION + b.scale - a.scale + 1);
  const scaled = a.unscaled * 10n ** (shift > 0n ? shift : 0n);
  const shrink = shift > 0n ? 0n : -shift;
  const num = scaled / 10n ** shrink;
  const q = num / b.unscaled;
  const rem = num % b.unscaled;
  const bumped = absBig(rem) * 2n >= absBig(b.unscaled) ? (q < 0n ? q - 1n : q + 1n) : q;
  return normalise(dec(bumped / 10n + (absBig(bumped % 10n) >= 5n ? (bumped < 0n ? -1n : 1n) : 0n), DIV_PRECISION));
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function cmp(a: Dec, b: Dec): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Integer exponent only: `2 ^ 0.5` is a root, and roots are `sqrt`. */
function pow(a: Dec, b: Dec): Dec {
  if (b.scale !== 0) {
    throw new ComputeError("the exponent must be a whole number — use sqrt() for roots");
  }
  const e = b.unscaled;
  if (e < 0n) return div(dec(1n, 0), pow(a, dec(-e, 0)));
  if (e > 4096n) throw new ComputeError("exponent too large");
  let out = dec(1n, 0);
  for (let i = 0n; i < e; i++) out = mul(out, a);
  return out;
}

/** Integer square root by Newton's method, then scaled back down. */
function sqrt(a: Dec): Dec {
  if (a.unscaled < 0n) throw new ComputeError("square root of a negative number");
  if (a.unscaled === 0n) return dec(0n, 0);
  const P = DIV_PRECISION;
  // Bring the radicand to an even scale of 2P so the root lands at scale P.
  const target = 2 * P;
  const n = a.unscaled * 10n ** BigInt(target - a.scale >= 0 ? target - a.scale : 0);
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return normalise(dec(x, P));
}

function roundTo(a: Dec, places: number): Dec {
  if (places < 0 || places > 100) throw new ComputeError("round() needs 0-100 places");
  if (a.scale <= places) return a;
  const drop = BigInt(a.scale - places);
  const factor = 10n ** drop;
  const q = a.unscaled / factor;
  const rem = absBig(a.unscaled % factor);
  const up = rem * 2n >= factor ? (a.unscaled < 0n ? -1n : 1n) : 0n;
  return normalise(dec(q + up, places));
}

function floorDec(a: Dec): Dec {
  if (a.scale === 0) return a;
  const f = 10n ** BigInt(a.scale);
  const q = a.unscaled / f;
  return dec(a.unscaled < 0n && a.unscaled % f !== 0n ? q - 1n : q, 0);
}

function ceilDec(a: Dec): Dec {
  if (a.scale === 0) return a;
  const f = 10n ** BigInt(a.scale);
  const q = a.unscaled / f;
  return dec(a.unscaled > 0n && a.unscaled % f !== 0n ? q + 1n : q, 0);
}

function format(d: Dec): string {
  const n = normalise(d);
  const neg = n.unscaled < 0n;
  let digits = absBig(n.unscaled).toString();
  if (n.scale === 0) return (neg ? "-" : "") + digits;
  digits = digits.padStart(n.scale + 1, "0");
  const cut = digits.length - n.scale;
  return `${neg ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export class ComputeError extends Error {}

// ---------------------------------------------------------------------------
// Parser — recursive descent, no eval
// ---------------------------------------------------------------------------

type Tok = { kind: "num"; value: Dec } | { kind: "op" | "name"; value: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // `_` groups digits, `,` does not. A comma already separates arguments,
    // so `min(1,234)` would be either two arguments or one number and there is
    // no reading of it that is obviously right. An ambiguity in a tool whose
    // entire purpose is to be trusted with a number is worse than the missing
    // convenience, so the comma is rejected rather than guessed at.
    if (c === "_") {
      i++;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[\d_]/.test(src[j])) j++;
      let scale = 0;
      if (src[j] === "." ) {
        j++;
        const start = j;
        while (j < src.length && /[\d_]/.test(src[j])) j++;
        scale = src.slice(start, j).replace(/_/g, "").length;
      }
      const raw = src.slice(i, j).replace(/_/g, "").replace(".", "");
      out.push({ kind: "num", value: dec(BigInt(raw === "" ? "0" : raw), scale) });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9]/.test(src[j])) j++;
      out.push({ kind: "name", value: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      out.push({ kind: "op", value: c });
      i++;
      continue;
    }
    throw new ComputeError(`unexpected character "${c}"`);
  }
  return out;
}

const FUNCS = new Set(["sqrt", "abs", "round", "floor", "ceil", "min", "max"]);

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private eat(op: string): boolean {
    const t = this.peek();
    if (t && t.kind === "op" && t.value === op) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): Dec {
    const v = this.expr();
    if (this.pos !== this.toks.length) {
      throw new ComputeError("trailing input after a complete expression");
    }
    return v;
  }

  /** `+` and `-`, lowest precedence. */
  private expr(): Dec {
    let left = this.term();
    for (;;) {
      if (this.eat("+")) left = add(left, this.term());
      else if (this.eat("-")) left = sub(left, this.term());
      else return left;
    }
  }

  /** `*`, `/`, `%`. */
  private term(): Dec {
    let left = this.unary();
    for (;;) {
      if (this.eat("*")) left = mul(left, this.unary());
      else if (this.eat("/")) left = div(left, this.unary());
      else if (this.eat("%")) {
        const r = this.unary();
        if (r.unscaled === 0n) throw new ComputeError("modulo by zero");
        const q = floorDec(div(left, r));
        left = sub(left, mul(q, r));
      } else return left;
    }
  }

  private unary(): Dec {
    if (this.eat("-")) return sub(dec(0n, 0), this.unary());
    if (this.eat("+")) return this.unary();
    return this.power();
  }

  /** `^`, right-associative and binding tighter than unary minus's operand. */
  private power(): Dec {
    const base = this.atom();
    if (this.eat("^")) return pow(base, this.unary());
    return base;
  }

  private atom(): Dec {
    const t = this.peek();
    if (!t) throw new ComputeError("expression ended early");
    if (t.kind === "num") {
      this.pos++;
      return t.value;
    }
    if (t.kind === "name") {
      this.pos++;
      const name = t.value;
      if (!FUNCS.has(name)) {
        throw new ComputeError(
          `unknown name "${name}" — available: ${[...FUNCS].sort().join(", ")}`
        );
      }
      if (!this.eat("(")) throw new ComputeError(`${name} needs parentheses`);
      const args: Dec[] = [this.expr()];
      while (this.eat(",")) args.push(this.expr());
      if (!this.eat(")")) throw new ComputeError(`${name} is missing its closing parenthesis`);
      return this.call(name, args);
    }
    if (this.eat("(")) {
      const v = this.expr();
      if (!this.eat(")")) throw new ComputeError("missing closing parenthesis");
      return v;
    }
    throw new ComputeError(`unexpected "${t.value}"`);
  }

  private call(name: string, args: Dec[]): Dec {
    const arity = (n: number) => {
      if (args.length !== n) {
        throw new ComputeError(`${name}() takes ${n} argument(s), got ${args.length}`);
      }
    };
    switch (name) {
      case "sqrt":
        arity(1);
        return sqrt(args[0]);
      case "abs":
        arity(1);
        return args[0].unscaled < 0n ? sub(dec(0n, 0), args[0]) : args[0];
      case "floor":
        arity(1);
        return floorDec(args[0]);
      case "ceil":
        arity(1);
        return ceilDec(args[0]);
      case "round": {
        if (args.length === 1) return roundTo(args[0], 0);
        arity(2);
        if (args[1].scale !== 0) throw new ComputeError("round() places must be whole");
        return roundTo(args[0], Number(args[1].unscaled));
      }
      case "min":
        return args.reduce((a, b) => (cmp(a, b) <= 0 ? a : b));
      case "max":
        return args.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
      default:
        throw new ComputeError(`unknown function "${name}"`);
    }
  }
}

/**
 * Evaluate an arithmetic expression exactly.
 *
 * Throws {@link ComputeError} with a reason a model can act on, never a raw
 * parser exception.
 */
export function compute(expression: string): string {
  const src = expression.trim();
  if (!src) throw new ComputeError("empty expression");
  if (src.length > 4096) throw new ComputeError("expression too long");
  return format(new Parser(tokenize(src)).parse());
}
