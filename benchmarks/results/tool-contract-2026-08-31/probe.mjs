import { executeTool } from "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/tools.js";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
const root="/tmp/tc-ws2";
const reset=()=>{rmSync(root,{recursive:true,force:true});mkdirSync(root+"/src",{recursive:true});
  writeFileSync(root+"/src/a.txt","IMPORTANT CONTENT\n");};
const ctx=()=>({root,sandbox:"confined",gate:"never",approve:async()=>true,timeoutMs:5000,maxOutputBytes:32000});
const offered=new Set(["read","write","edit","bash"]);

reset();
let o = await executeTool("write", { path: "src/a.txt" }, ctx(), offered);
console.log("  write with NO content on an existing file:");
console.log("    code:", o.code, "| summary:", o.summary);
console.log("    file now:", JSON.stringify(readFileSync(root+"/src/a.txt","utf-8")));

reset();
o = await executeTool("bash", { command: { evil: true } }, ctx(), offered);
console.log("  bash with a non-string command:");
console.log("    code:", o.code, "| summary:", o.summary);
console.log("    content:", JSON.stringify((o.content||"").slice(0,120)));

reset();
o = await executeTool("read", {}, ctx(), offered);
console.log("  read with no path:  code:", o.code, "| summary:", o.summary);

reset();
o = await executeTool("read", { path: "" }, ctx(), offered);
console.log("  read with empty path:  code:", o.code, "| summary:", o.summary);

reset();
o = await executeTool("read", ["src/a.txt"], ctx(), offered);
console.log("  read with array args:  code:", o.code, "| summary:", o.summary);
