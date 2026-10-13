import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { finalizeRuntimeExit } from "../lib/runtime-shutdown.mjs";

async function listeningServer(t) {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write("pending fixture"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => { server.closeAllConnections(); if (server.listening) server.close(); });
  return { server, port };
}

function controls() {
  const calls = [];
  return { calls, releaseGate: () => calls.push("gate-released"), setExitCode: (code) => calls.push(["exitCode", code]),
    forceExit: (code) => calls.push(["force", code]), log: () => calls.push("success-log"), error: () => calls.push("error-log"), drainMs: 1, closeTimeoutMs: 100 };
}

test("ordinary shutdown always stops the owned listener and exits naturally", async (t) => {
  const { server } = await listeningServer(t);
  const mocked = controls();
  assert.deepEqual(await finalizeRuntimeExit({ server, ...mocked }), { exitCode: 0, forced: false });
  assert.equal(server.listening, false);
  assert.deepEqual(mocked.calls, ["gate-released", ["exitCode", 0], "success-log"]);
});

test("failed/deadline shutdown closes an active socket and listener before the bounded nonzero fallback", async (t) => {
  for (const description of ["cleanup rejected", "45-second deadline expired"]) {
    const { server, port } = await listeningServer(t);
    const socket = net.createConnection({ host: "127.0.0.1", port });
    t.after(() => socket.destroy());
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await new Promise((resolve) => socket.once("data", resolve));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    const mocked = controls();
    const originalForce = mocked.forceExit;
    mocked.forceExit = (code) => {
      assert.equal(server.listening, false, description + ": listener must already be stopped");
      originalForce(code);
    };
    assert.deepEqual(await finalizeRuntimeExit({ server, exitCode: 1, ...mocked }), { exitCode: 1, forced: true });
    await closed;
    assert.deepEqual(mocked.calls.filter(Array.isArray), [["exitCode", 1], ["force", 1]]);
    assert.ok(mocked.calls.includes("gate-released"));
    assert.equal(mocked.calls.includes("success-log"), false);
  }
});

test("an unstarted listen-race server is finalized without treating ERR_SERVER_NOT_RUNNING as a new failure", async () => {
  const server = http.createServer();
  const mocked = controls();
  assert.deepEqual(await finalizeRuntimeExit({ server, ...mocked }), { exitCode: 0, forced: false });
  assert.equal(server.listening, false);
});

test("a stalled listener-close callback still releases ownership and requests bounded failure exit", async () => {
  const order = [];
  const server = { close: () => order.push("stop-listener"), closeAllConnections: () => order.push("close-connections") };
  const mocked = controls();
  assert.deepEqual(await finalizeRuntimeExit({ server, ...mocked, closeTimeoutMs: 5 }), { exitCode: 1, forced: true });
  assert.deepEqual(order, ["stop-listener", "close-connections"]);
  assert.deepEqual(mocked.calls.filter(Array.isArray), [["exitCode", 1], ["force", 1]]);
});

test("real error/deadline subprocess exits nonzero instead of leaving an owned worker or listener alive", async () => {
  for (const failure of ["reject", "deadline"]) {
    const helper = new URL("../lib/runtime-shutdown.mjs", import.meta.url).href;
    const source = `import http from 'node:http';import {finalizeRuntimeExit} from ${JSON.stringify(helper)};
      const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      console.log('fixture-port='+server.address().port);setInterval(()=>{},1000);
      try { await ${failure === "reject" ? "Promise.reject(new Error('cleanup fixture failure'))" : "Promise.race([new Promise(()=>{}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('deadline fixture failure')),5))])"}; }
      catch { await finalizeRuntimeExit({server,exitCode:1,drainMs:25,closeTimeoutMs:50}); }`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Error shutdown left a background child running.")); }, 5000);
      child.on("error", reject);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /已停止本次后台监听/);
    assert.doesNotMatch(result.stderr, /Assertion failed|UV_HANDLE_CLOSING/);
    const port = Number(result.stdout.match(/fixture-port=(\d+)/)?.[1]);
    assert.ok(port > 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }));
  }
});
