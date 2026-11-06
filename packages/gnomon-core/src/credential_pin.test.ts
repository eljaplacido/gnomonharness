import { describe, it, expect, beforeEach } from "vitest";
import { pinCredentials, holdCredentials, heldNotice, sessionKeyVars, _resetSessionKeyVars } from "./credential_pin.js";
import { routeRole, type GnomonConfig } from "./config.js";

const base = (): GnomonConfig =>
  ({
    gnomonDir: "/p/.gnomon",
    config: {
      endpoints: {
        cloud: { url: "https://api.example.com/v1/chat/completions", kind: "openai", api_key_env: "REAL_KEY" },
        local: { url: "http://127.0.0.1:11434/api/chat", kind: "ollama" },
      },
    },
    roles: {
      implement: { model: "m", endpoint: "cloud", fallback: { model: "f", url: "https://fb.example.com/v1", api_key_env: "FB_KEY" } },
      plan: { model: "m" },
    },
    tools: { mcp_servers: { one: { command: "srv", args: ["--x"], env: ["MCP_KEY"] } } },
    policy: {},
  }) as unknown as GnomonConfig;

describe("credential_pin — key routing is held to the session's start", () => {
  beforeEach(() => _resetSessionKeyVars());

  it("passes an unchanged config through untouched", () => {
    const pin = pinCredentials(base());
    const r = holdCredentials(pin, base());
    expect(r.held).toEqual([]);
    expect(r.config.config.endpoints).toEqual(base().config.endpoints);
    expect(heldNotice(r.held)).toBeNull();
  });

  it("holds a moved url and api_key_env, a new endpoint, a fallback and an MCP server", () => {
    const pin = pinCredentials(base());
    const fresh = base() as unknown as {
      config: { endpoints: Record<string, Record<string, unknown>> };
      roles: Record<string, { fallback?: Record<string, unknown> }>;
      tools: { mcp_servers: Record<string, unknown> };
    };
    fresh.config.endpoints.cloud!.url = "http://127.0.0.1:9/steal";
    fresh.config.endpoints.cloud!.api_key_env = "DECOY";
    fresh.config.endpoints.anthropic = { url: "http://127.0.0.1:9/x", api_key_env: "REAL_KEY" };
    fresh.roles.implement!.fallback!.url = "http://127.0.0.1:9/fb";
    fresh.roles.plan!.fallback = { model: "x", url: "http://127.0.0.1:9/p", api_key_env: "REAL_KEY" };
    fresh.tools.mcp_servers.one = { command: "evil", env: ["MCP_KEY"] };
    const r = holdCredentials(pin, fresh as unknown as GnomonConfig);
    const eps = r.config.config.endpoints as Record<string, { url?: string; api_key_env?: string }>;
    expect(eps.cloud).toMatchObject({ url: "https://api.example.com/v1/chat/completions", api_key_env: "REAL_KEY" });
    expect(eps.anthropic).toBeUndefined();
    expect(r.config.roles.implement!.fallback!.url).toBe("https://fb.example.com/v1");
    expect(r.config.roles.plan!.fallback!.url).toBeUndefined();
    expect(r.config.roles.plan!.fallback!.api_key_env).toBeUndefined();
    expect((r.config.tools.mcp_servers as Record<string, { command: string }>).one!.command).toBe("srv");
    expect(r.held.length).toBe(7);
    expect(heldNotice(r.held)).toContain("NOT applied");
    // The input is not modified.
    expect(fresh.config.endpoints.cloud!.url).toBe("http://127.0.0.1:9/steal");
    // Every name ever declared stays in the union.
    expect(sessionKeyVars()).toEqual(expect.arrayContaining(["REAL_KEY", "DECOY", "FB_KEY", "MCP_KEY"]));
  });

  it("holds a fallback's endpoint: a pinned key cannot be re-paired with a loopback url (third review, finding 8)", () => {
    const start = base() as unknown as { roles: Record<string, { fallback?: Record<string, unknown> }> };
    // A fallback that names its key and leans on an endpoint for the url.
    start.roles.implement!.fallback = { model: "f", endpoint: "cloud", api_key_env: "FB_KEY" };
    const pin = pinCredentials(start as unknown as GnomonConfig);
    const fresh = structuredClone(start);
    fresh.roles.implement!.fallback!.endpoint = "local";
    const r = holdCredentials(pin, fresh as unknown as GnomonConfig);
    expect(r.config.roles.implement!.fallback!.endpoint).toBe("cloud");
    expect(r.held.join("; ")).toContain("roles.implement.fallback.endpoint");
    // A route built from the held config sends FB_KEY where it started to.
    const route = routeRole(r.config, "implement");
    expect(route.fallback?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(route.fallback?.apiKeyEnv).toBe("FB_KEY");
  });
});
