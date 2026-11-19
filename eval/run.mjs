// Run eval/questions.json against the built server, offline (#55). Each question's reply is a
// recorded fixture or a generated success reply; fetch is stubbed, so nothing reaches
// Checkbook NYC. Prints one line per question and writes eval/runs/YYYY-MM-DD.json.
//   npm run eval            (builds first)
// Exit 0 when every check passes, 1 otherwise. test/eval.test.mjs runs the same questions.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";

const root = new URL("../", import.meta.url);
export const QUESTIONS = JSON.parse(readFileSync(new URL("eval/questions.json", root), "utf8")).questions;

function replyBody(q) {
  if (q.fixture) return readFileSync(new URL(`test/fixtures/${q.fixture}`, root), "utf8");
  if (q.reply) {
    const tx = Array.from({ length: q.reply.rows }, (_, i) => `<transaction><n>${i + 1}</n></transaction>`).join("");
    return `<response><status><result>success</result></status><result_records><record_count>${q.reply.count}</record_count><t>${tx}</t></result_records></response>`;
  }
  return "";
}

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Ask one question. Returns { id, pass, failures[] }. */
export async function ask(q) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(String(init?.body ?? ""));
    return new Response(replyBody(q), { status: 200 });
  };
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "0" });
  registerTools(server);
  const client = new Client({ name: "eval", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  let res;
  try {
    res = await client.callTool({ name: q.tool, arguments: q.args });
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
  }
  const text = res.content.map((c) => c.text ?? "").join("\n");
  const c = q.check;
  const failures = [];
  if (c.requests !== undefined && sent.length !== c.requests) failures.push(`sent ${sent.length} request(s), expected ${c.requests}`);
  const body = sent.join("\n");
  for (const s of c.sent_includes ?? []) if (!body.includes(s)) failures.push(`request lacks ${s}`);
  for (const s of c.sent_excludes ?? []) if (body.includes(s)) failures.push(`request has ${s}`);
  const isError = res.isError === true;
  if ((c.is_error ?? false) !== isError) failures.push(`isError ${isError}, expected ${c.is_error ?? false}: ${text.slice(0, 200)}`);
  for (const re of c.text ?? []) if (!new RegExp(re).test(text)) failures.push(`answer does not match /${re}/`);
  if (c.field) {
    let json;
    try {
      json = JSON.parse(text.split("\n\n")[0]);
    } catch {
      failures.push("answer has no JSON");
    }
    for (const [path, want] of c.field) {
      const got = get(json, path);
      if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${path} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }
  return { id: q.id, q: q.q, pass: failures.length === 0, failures };
}

async function main() {
  const results = [];
  for (const q of QUESTIONS) {
    const r = await ask(q);
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.q}${r.failures.length ? "\n      " + r.failures.join("\n      ") : ""}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} of ${results.length} passed.`);
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  mkdirSync(new URL("eval/runs/", root), { recursive: true });
  writeFileSync(
    new URL(`eval/runs/${date}.json`, root),
    JSON.stringify({ date, node: process.version, passed, total: results.length, results }, null, 2) + "\n"
  );
  return passed === results.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
