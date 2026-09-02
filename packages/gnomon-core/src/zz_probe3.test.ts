import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { AuditTrail, AuditKind, AuditRecord, ResolvedAudit, recordHash } from "./audit.js";
import { loadConfig, recomputeManifest, GnomonConfig } from "./config.js";
import { replay } from "./replay.js";
const HARNESS = "gnomon/0.1.0+testpin";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "p3-")); delete process.env.GNOMON_MODEL_URL; });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const C = `\n[defaults]\napproval = "on_write"\nsandbox = "confined"\n`;
const R = `\n[roles.implement]\nmodel = "local:large"\nendpoint = "local"\n\n[roles.review]\nmodel = "local:small"\ntools = ["read"]\n`;
const T = `\n[[tools]]\nname = "read"\ndescription="d"\nenabled=true\n\n[[tools]]\nname="bash"\ndescription="d"\nenabled=true\n\n[[tools]]\nname="write"\ndescription="d"\nenabled=true\n\n[[tools]]\nname="task"\ndescription="d"\nenabled=true\n`;
function surface(): GnomonConfig { const d=join(root,".gnomon"); mkdirSync(d,{recursive:true});
  for (const [n,b] of Object.entries({ "config.toml":C,"roles.toml":R,"tools.toml":T,"policy.toml":"","system.md":"be useful\n" })) writeFileSync(join(d,n),b as string);
  return loadConfig(root); }
const hashOf=(c:GnomonConfig)=>recomputeManifest(c.gnomonDir,"0.1.0").surface_hash;
const S=():ResolvedAudit=>({enabled:true,dir:join(root,".gnomon-audit"),record:"metadata",redact:[],chain:true,invalid_redact:[]});
function trail(recs:Array<[AuditKind,Record<string,unknown>]>):string{const t=new AuditTrail(S(),`s${Math.random().toString(36).slice(2)}`);for(const[k,f]of recs)t.write(k,f);return t.path!;}
const find=(r:any,k:string,f:string)=>r.entries.filter((e:any)=>e.kind===k).flatMap((e:any)=>e.checks).find((c:any)=>c.field===f);

describe("PROBE 3: the delegated tool_log path", () => {
  it("P1 delegated turn with a tool_log entry that matches NO record", () => {
    const c=surface(); const h=hashOf(c);
    const p=trail([
      ["session_start",{surface_hash:h,harness:HARNESS,roles:["implement","review"],record:"metadata"}],
      ["tool_call",{role:"review",tool:"read",gated:false,code:0,bucket:"result",summary:"read — sub"}],
      ["tool_call",{role:"implement",tool:"task",gated:true,code:0,bucket:"result",summary:"task — review (1 step)"}],
      // The log claims a write that no tool_call record supports.
      ["turn",{turn:1,role:"implement",model:"local:large",bucket:"result",code:0,tool_steps:1,tool_log:["write — /etc/passwd"],surface_hash:h}],
      ["session_end",{turns:1,surface_hash:h}],
    ]);
    const r=replay(p,c,{harness:HARNESS});
    console.log("P1 verdict:",r.verdict,"tool_log:",JSON.stringify(find(r,"turn","tool_log")));
  });

  it("P2 ATTACK: insert a bogus `task` call to DOWNGRADE the log check on a lying turn", () => {
    const c=surface(); const h=hashOf(c);
    // Without the task call this would be an exact-equality check and diverge.
    const p=trail([
      ["session_start",{surface_hash:h,harness:HARNESS,roles:["implement","review"],record:"metadata"}],
      ["tool_call",{role:"implement",tool:"read",gated:false,code:0,bucket:"result",summary:"read — a"}],
      ["tool_call",{role:"implement",tool:"task",gated:true,code:0,bucket:"result",summary:"task — review (0 steps)"}],
      // Real run did read+task; the log hides the task and under-reports steps.
      ["turn",{turn:1,role:"implement",model:"local:large",bucket:"result",code:0,tool_steps:1,tool_log:["read — a"],surface_hash:h}],
      ["session_end",{turns:1,surface_hash:h}],
    ]);
    const r=replay(p,c,{harness:HARNESS});
    console.log("P2 verdict:",r.verdict,"tool_log:",JSON.stringify(find(r,"turn","tool_log")),"steps:",JSON.stringify(find(r,"turn","tool_steps")));
  });

  it("P3 same lying turn WITHOUT a task call (control)", () => {
    const c=surface(); const h=hashOf(c);
    const p=trail([
      ["session_start",{surface_hash:h,harness:HARNESS,roles:["implement","review"],record:"metadata"}],
      ["tool_call",{role:"implement",tool:"read",gated:false,code:0,bucket:"result",summary:"read — a"}],
      ["tool_call",{role:"implement",tool:"bash",gated:true,code:0,bucket:"result",summary:"bash — curl evil"}],
      ["turn",{turn:1,role:"implement",model:"local:large",bucket:"result",code:0,tool_steps:1,tool_log:["read — a"],surface_hash:h}],
      ["session_end",{turns:1,surface_hash:h}],
    ]);
    const r=replay(p,c,{harness:HARNESS});
    console.log("P3 verdict:",r.verdict,"tool_log:",JSON.stringify(find(r,"turn","tool_log")),"steps:",JSON.stringify(find(r,"turn","tool_steps")));
  });
});
