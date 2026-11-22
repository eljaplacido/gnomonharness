/**
 * `[skills] inline_max_tokens` (CONTRACTS section 54): a matched skill larger
 * than the limit enters the prompt as name, one-line description and path; the
 * model opens it with `read`. Absent means every matched skill in full, as it
 * always was. Servers are fakes on 127.0.0.1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { applySkills, inlineMaxTokens, skillBlock, loadSkills } from "./skills.js";
import { buildSystemPrompt, runTask, skillTokens, type PromptState } from "./prompt_loop.js";
import { estimateTokens } from "./message_tokens.js";

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const BIG_BODY = "Always run the migration dry-run first.\n" + "Detail line about migrations.\n".repeat(120);
const SMALL_BODY = "Prefer tabs.";

async function serve(replies: unknown[]) {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replies[Math.min(bodies.length, replies.length) - 1]));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
}

function surface(url: string, policy: string) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-progskill-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 512\n\n[audit]\nenabled = true\n\n[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(join(root, ".gnomon", "policy.toml"), policy);
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read"]\nmax_steps = 4\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  writeFileSync(
    join(root, ".gnomon", "skills", "migrations.md"),
    `+++\nname = "Migrations"\ndescription = "How to run database migrations safely"\nmatch = 'migrat'\n+++\n${BIG_BODY}`
  );
  writeFileSync(
    join(root, ".gnomon", "skills", "tabs.md"),
    `+++\nname = "Tabs"\ndescription = "Indentation"\nmatch = 'migrat'\n+++\n${SMALL_BODY}`
  );
  return root;
}

const stateOf = (root: string): PromptState => ({ config: loadConfig(root), exchanges: [], currentRole: "smol" }) as unknown as PromptState;

describe("[skills] inline_max_tokens", () => {
  it("absent: the prompt is the one applySkills always built", () => {
    const root = surface("http://x/", "");
    const state = stateOf(root);
    expect(inlineMaxTokens(state.config)).toBeUndefined();
    const prompt = buildSystemPrompt(state, "smol", "run the migration");
    expect(prompt).toContain(BIG_BODY.trim());
    expect(prompt).toContain(SMALL_BODY);
    const skills = loadSkills(state.config);
    expect(applySkills("S", skills)).toBe(applySkills("S", skills, [], ".gnomon/skills", undefined));
    expect(applySkills("S", skills)).toContain(skillBlock(skills[0]!));
  });

  it("a non-positive or non-numeric value reads as absent", () => {
    for (const v of ["0", "-5", '"big"']) {
      expect(inlineMaxTokens(loadConfig(surface("http://x/", `[skills]\ninline_max_tokens = ${v}\n`)))).toBeUndefined();
    }
  });

  it("a big matched skill goes in as a stub, a small one stays inline", () => {
    const root = surface("http://x/", "[skills]\ninline_max_tokens = 200\n");
    const state = stateOf(root);
    const prompt = buildSystemPrompt(state, "smol", "run the migration");
    expect(prompt).toContain("### Migrations\nHow to run database migrations safely");
    expect(prompt).toContain(".gnomon/skills/migrations.md");
    expect(prompt).not.toContain("Detail line about migrations");
    expect(prompt).toContain(SMALL_BODY);
    const full = loadSkills(state.config).find((s) => s.id === "migrations")!;
    expect(skillTokens(full, 200)).toBeLessThan(estimateTokens(skillBlock(full)) / 4);
    expect(skillTokens(full)).toBe(estimateTokens(skillBlock(full)));
  });

  it("the model reads the stub's path with read; the read and the savings are counted", async () => {
    const call = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: ".gnomon/skills/migrations.md" }) } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const done = { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] };
    const s = await serve([call, done]);
    const root = surface(s.url, "[skills]\ninline_max_tokens = 200\n");
    const rec = await runTask(loadConfig(root), "run the migration", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    const sys = s.bodies[0]!.messages[0].content as string;
    expect(sys).not.toContain("Detail line about migrations");
    // The second request carries what the read returned: the body.
    expect(JSON.stringify(s.bodies[1]!.messages)).toContain("Detail line about migrations");
    const sk = rec.counters.skills!;
    expect(sk.read).toEqual({ migrations: 1 });
    expect(sk.stubbed).toHaveLength(1);
    expect(sk.stubbed![0]).toMatchObject({ name: "migrations" });
    expect(sk.stubbed![0]!.tokens_saved).toBeGreaterThan(300);
    const dir = join(root, ".gnomon-audit");
    const recs = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
      : [];
    const use = recs.find((r) => r.kind === "skill_use");
    expect(use.stubbed).toEqual(sk.stubbed);
  });

  it("absent: no stubbed field on counters or record", async () => {
    const done = { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] };
    const s = await serve([done]);
    const root = surface(s.url, "");
    const rec = await runTask(loadConfig(root), "run the migration", { role: "smol", yes: true });
    expect(rec.counters.skills).toBeDefined();
    expect(rec.counters.skills).not.toHaveProperty("stubbed");
    expect(s.bodies[0]!.messages[0].content).toContain("Detail line about migrations");
  });
});
