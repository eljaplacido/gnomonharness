/**
 * gnomon-core: Credential store tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  loadCredentials,
  setCredential,
  unsetCredential,
  listCredentials,
  applyCredentials,
  saveCredentials,
  suppliedByStore,
  isShellExported,
} from "./credentials.js";

let dir: string;
let store: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gnomon-cred-"));
  store = join(dir, "credentials.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("credentialsPath", () => {
  it("lives outside any repository", () => {
    // A path relative to the project would eventually be committed by someone.
    const p = credentialsPath();
    expect(p).not.toContain(".gnomon/");
    expect(p).toContain("gnomon");
    expect(p.endsWith("credentials.json")).toBe(true);
  });

  it("honours XDG_DATA_HOME", () => {
    const original = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/tmp/xdg-example";
    try {
      expect(credentialsPath()).toBe("/tmp/xdg-example/gnomon/credentials.json");
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });
});

describe("storage", () => {
  it("round-trips a value", () => {
    setCredential("SOME_KEY", "s3cret", store);
    expect(loadCredentials(store).SOME_KEY).toBe("s3cret");
  });

  it("is written owner-only", () => {
    setCredential("SOME_KEY", "s3cret", store);
    // 0600: a secret readable by other users on the machine is not stored.
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });

  it("stays owner-only when rewritten", () => {
    setCredential("A", "1", store);
    writeFileSync(store, "{}", { mode: 0o644 });
    setCredential("B", "2", store);
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });

  it("lists names, never values", () => {
    setCredential("K1", "v1", store);
    setCredential("K2", "v2", store);
    expect(listCredentials(store)).toEqual(["K1", "K2"]);
    expect(JSON.stringify(listCredentials(store))).not.toContain("v1");
  });

  it("unset removes only that variable", () => {
    setCredential("K1", "v1", store);
    setCredential("K2", "v2", store);
    expect(unsetCredential("K1", store)).toBe(true);
    expect(listCredentials(store)).toEqual(["K2"]);
    expect(unsetCredential("MISSING", store)).toBe(false);
  });

  it("a corrupt store does not stop the harness", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(store, "not json at all");
    expect(loadCredentials(store)).toEqual({});
    expect(() => applyCredentials(store)).not.toThrow();
  });
});

describe("applyCredentials", () => {
  const withEnv = (vars: Record<string, string | undefined>, run: () => void) => {
    const originals: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) originals[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      run();
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("supplies a variable the shell has not set", () => {
    setCredential("GNOMON_TEST_KEY", "from-store", store);
    withEnv({ GNOMON_TEST_KEY: undefined }, () => {
      expect(applyCredentials(store)).toEqual(["GNOMON_TEST_KEY"]);
      expect(process.env.GNOMON_TEST_KEY).toBe("from-store");
    });
  });

  it("never overrides an exported variable", () => {
    // CI secrets and deliberate exports must win; silently replacing one would
    // be exactly the machine-scoped surprise this harness exists to prevent.
    setCredential("GNOMON_TEST_KEY", "from-store", store);
    withEnv({ GNOMON_TEST_KEY: "from-shell" }, () => {
      expect(applyCredentials(store)).toEqual([]);
      expect(process.env.GNOMON_TEST_KEY).toBe("from-shell");
    });
  });

  it("reports which names it supplied, so the loop can say so without saying what", () => {
    setCredential("GNOMON_A", "1", store);
    setCredential("GNOMON_B", "2", store);
    withEnv({ GNOMON_A: undefined, GNOMON_B: undefined }, () => {
      const supplied = applyCredentials(store);
      expect(supplied).toEqual(["GNOMON_A", "GNOMON_B"]);
      expect(supplied.join()).not.toContain("1");
    });
  });
});

describe("precedence reporting", () => {
  it("distinguishes what this process injected from what the shell exported", () => {
    // key list claimed an exported variable took precedence over every stored
    // key, because applyCredentials had loaded them moments earlier.
    setCredential("GNOMON_PREC_A", "stored", store);
    const original = process.env.GNOMON_PREC_A;
    delete process.env.GNOMON_PREC_A;
    try {
      applyCredentials(store);
      expect(suppliedByStore()).toContain("GNOMON_PREC_A");
      expect(isShellExported("GNOMON_PREC_A")).toBe(false);
    } finally {
      if (original === undefined) delete process.env.GNOMON_PREC_A;
      else process.env.GNOMON_PREC_A = original;
    }
  });

  it("a genuine export is reported as taking precedence", () => {
    setCredential("GNOMON_PREC_B", "stored", store);
    const original = process.env.GNOMON_PREC_B;
    process.env.GNOMON_PREC_B = "from-shell";
    try {
      applyCredentials(store);
      expect(suppliedByStore()).not.toContain("GNOMON_PREC_B");
      expect(isShellExported("GNOMON_PREC_B")).toBe(true);
    } finally {
      if (original === undefined) delete process.env.GNOMON_PREC_B;
      else process.env.GNOMON_PREC_B = original;
    }
  });

  it("saveCredentials writes what loadCredentials reads", () => {
    saveCredentials({ A: "1", B: "2" }, store);
    expect(loadCredentials(store)).toEqual({ A: "1", B: "2" });
  });
});
