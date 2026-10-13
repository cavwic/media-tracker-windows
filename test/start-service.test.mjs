import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { BootstrapPreflightError, BOOTSTRAP_EXIT_CODES, runServiceBootstrap, startupStage, writeBootstrapStatus } from "../scripts/start-service.mjs";

function fixture(overrides = {}) {
  const events = [];
  const environment = { MEDIA_TRACKER_LAUNCH_STARTED_AT_MS: String(Date.now() - 100),
    MEDIA_TRACKER_BOOTSTRAP_TOKEN: "a".repeat(32), MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE: path.join(os.tmpdir(), "status-fixture.json"),
    MEDIA_TRACKER_DATA_DIR: "sentinel", MEDIA_TRACKER_NO_OPEN: "1", COLLECTOR_TEST_INHERITED: "keep" };
  return { events, environment, options: {
    environment, nodeVersion: "24.14.1", stage: (name) => events.push(name),
    loadPlaywright: async () => { events.push("playwright-import"); return { chromium: { executablePath: () => "private-fixture.exe" } }; },
    executableExists: (filename) => { assert.equal(filename, "private-fixture.exe"); events.push("runtime-exists"); return true; },
    loadService: async () => { events.push("service-import"); return { fixture: true }; },
    ...overrides,
  } };
}

test("bootstrap validates and imports the service once in the same process, stripping only its private status controls", async () => {
  const setup = fixture();
  assert.deepEqual(await runServiceBootstrap(setup.options), { fixture: true });
  assert.deepEqual(setup.events, ["bootstrap-start", "playwright-import", "runtime-exists", "runtime-ready", "service-import", "service-imported"]);
  assert.equal(setup.environment.MEDIA_TRACKER_BOOTSTRAP_TOKEN, undefined);
  assert.equal(setup.environment.MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE, undefined);
  assert.equal(setup.environment.MEDIA_TRACKER_DATA_DIR, "sentinel");
  assert.equal(setup.environment.MEDIA_TRACKER_NO_OPEN, "1");
  assert.equal(setup.environment.COLLECTOR_TEST_INHERITED, "keep");
  assert.ok(Number(setup.environment.MEDIA_TRACKER_LAUNCH_STARTED_AT_MS) > 0);
});

test("unsupported Node is rejected before imports or preparation and retains marker controls for the launcher", async () => {
  const setup = fixture({ nodeVersion: "18.20.0" });
  await assert.rejects(runServiceBootstrap(setup.options), (error) => error instanceof BootstrapPreflightError
    && error.exitCode === BOOTSTRAP_EXIT_CODES.nodeVersion && error.reason === "unsupported-node");
  assert.deepEqual(setup.events, ["bootstrap-start"]);
  assert.equal(setup.environment.MEDIA_TRACKER_BOOTSTRAP_TOKEN, "a".repeat(32));
});

test("missing Playwright and missing Chromium are typed preflight errors, not service failures", async () => {
  for (const kind of ["dependencies", "chromium"]) {
    const setup = fixture(kind === "dependencies"
      ? { loadPlaywright: async () => { throw Object.assign(new Error("Local missing module"), { code: "ERR_MODULE_NOT_FOUND" }); } }
      : { executableExists: () => false });
    await assert.rejects(runServiceBootstrap(setup.options), (error) => error instanceof BootstrapPreflightError
      && error.exitCode === BOOTSTRAP_EXIT_CODES[kind]);
    assert.ok(!setup.events.includes("service-import"));
  }
});

test("unexpected module/service failures cannot be converted into automatic installation markers", async () => {
  const error = Object.assign(new Error("Application failure"), { code: 22 });
  const setup = fixture({ loadService: async () => { throw error; } });
  await assert.rejects(runServiceBootstrap(setup.options), (actual) => actual === error);
  assert.equal(await writeBootstrapStatus(error, setup.environment), false);
  const importFailure = Object.assign(new Error("Runtime execution failure"), { code: "EACCES" });
  await assert.rejects(runServiceBootstrap(fixture({ loadPlaywright: async () => { throw importFailure; } }).options),
    (actual) => actual === importFailure);
});

test("typed status is nonce-bound, create-only and contains no account/cookie or environment data", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "collector-bootstrap-status-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("collector-bootstrap-status-"));
    await rm(temporary, { recursive: true, force: true });
  });
  const filename = path.join(temporary, "status.json");
  const environment = { MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE: filename, MEDIA_TRACKER_BOOTSTRAP_TOKEN: "a".repeat(32), PRIVATE_SENTINEL: "Do not disclose" };
  const failure = new BootstrapPreflightError("chromium", "Local preflight failure");
  assert.equal(await writeBootstrapStatus(failure, environment), true);
  const text = await readFile(filename, "utf8");
  assert.deepEqual(JSON.parse(text), { schemaVersion: 1, token: "a".repeat(32), reason: "missing-chromium", exitCode: 22 });
  assert.ok(!text.includes("PRIVATE_SENTINEL") && !text.includes(environment.PRIVATE_SENTINEL));
  await assert.rejects(writeBootstrapStatus(failure, environment), (error) => error.code === "EEXIST");
  assert.equal(await readFile(filename, "utf8"), text);
  assert.equal(await writeBootstrapStatus(failure, { ...environment, MEDIA_TRACKER_BOOTSTRAP_TOKEN: "bad" }), false);
  assert.equal(await writeBootstrapStatus(failure, { ...environment, MEDIA_TRACKER_BOOTSTRAP_STATUS_FILE: "relative.json" }), false);
});

test("startup timing logs only component stage and numeric elapsed time", () => {
  const lines = [];
  startupStage("runtime-ready", { MEDIA_TRACKER_LAUNCH_STARTED_AT_MS: String(Date.now() - 100),
    PRIVATE_ACCOUNT: "do-not-log", PRIVATE_COOKIE: "do-not-log" }, (line) => lines.push(line));
  assert.match(lines[0], /^\[startup\] runtime-ready elapsed=\d+ms$/);
  assert.ok(!lines[0].includes("do-not-log"));
});
