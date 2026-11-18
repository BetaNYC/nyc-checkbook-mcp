// #58: in server mode, stdout carries only the protocol (one JSON-RPC message per line);
// anything else would corrupt the stream for the client. Starts the built server, sends
// initialize and tools/list, and checks every line it wrote. No network: neither call
// reaches Checkbook NYC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

test("#58 stdout is nothing but JSON-RPC messages", async () => {
  const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no tools/list answer; stdout so far: ${out.slice(0, 500)}`)), 15_000);
    child.stdout.on("data", (d) => {
      out += d;
      if (/"id":2[,}]/.test(out) && out.endsWith("\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "stdout-test", version: "0" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  try {
    await done;
  } finally {
    child.kill();
  }
  const lines = out.split("\n").filter((l) => l !== "");
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    let msg;
    assert.doesNotThrow(() => (msg = JSON.parse(line)), `not JSON-RPC: ${line.slice(0, 200)}`);
    assert.equal(msg.jsonrpc, "2.0", line.slice(0, 200));
  }
  assert.ok(JSON.parse(lines.at(-1)).result.tools.length > 0);
});
