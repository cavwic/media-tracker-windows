import test from "node:test";
import { publicApiFetch as fetch } from "./public-api-client.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { chromium } from "playwright";
import { deletePersonDirectory, resolvePersonDeletionTarget } from "../lib/person-delete.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

function waitForServiceStartup(child, timeoutMs = 10_000) {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onErrors);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (message) => {
      cleanup();
      reject(new Error(`${message}\nstdout: ${output}\nstderr: ${errors}`));
    };
    const onOutput = (chunk) => {
      output = (output + chunk).slice(-65_536);
      if (!output.includes("已启动")) return;
      cleanup();
      resolve(output);
    };
    const onErrors = (chunk) => { errors = (errors + chunk).slice(-65_536); };
    const onError = (error) => fail(`测试服务启动失败: ${error.message}`);
    const onExit = (code, signal) => fail(`测试服务提前退出 (${code}, ${signal ?? "无信号"})`);
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onErrors);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => fail("测试服务启动超时"), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

// A dedicated temporary sibling avoids Windows protected AppData and the app root.
async function withFixture(callback) {
  const root = await mkdtemp(path.join(path.dirname(projectRoot), ".media-tracker-delete-test-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function options(root, persons, personId = "one") {
  return { personId, persons, projectRoot, dataRoot: path.join(root, "data") };
}

test("person deletion removes only its exact configured directory and leaves sibling files", async () => {
  await withFixture(async (root) => {
    const person = { id: "one", name: "人物 一", folderPath: path.join(root, "人物 一") };
    await mkdir(path.join(person.folderPath, "X", "account", "Image"), { recursive: true });
    await writeFile(path.join(person.folderPath, "X", "account", "Image", "a.jpg"), "test media");
    const sibling = path.join(root, "unrelated.txt");
    await writeFile(sibling, "preserve");
    assert.deepEqual(await deletePersonDirectory(options(root, [person])), { filesDeleted: true, folderMissing: false });
    await assert.rejects(stat(person.folderPath), { code: "ENOENT" });
    assert.equal(await readFile(sibling, "utf8"), "preserve");
    assert.deepEqual(await deletePersonDirectory(options(root, [person])), { filesDeleted: false, folderMissing: true });
    await assert.rejects(deletePersonDirectory(options(root, [person], "unknown")), { status: 404 });
  });
});

test("person deletion rejects roots, application data, and another person's overlapping folders", async () => {
  await withFixture(async (root) => {
    const paths = [path.parse(root).root, os.homedir(), projectRoot, path.dirname(projectRoot), path.join(root, "data"), path.join(root, "data", "nested")];
    if (process.platform === "win32") paths.push("\\\\server\\share", "\\\\?\\C:\\unsafe", "C:\\archive:stream");
    for (const folderPath of paths) {
      await assert.rejects(resolvePersonDeletionTarget(options(root, [{ id: "one", name: "one", folderPath }])), { status: 400 });
    }
    const folderPath = path.join(root, "archive");
    await mkdir(folderPath);
    for (const otherFolder of [folderPath, path.join(folderPath, "child"), root]) {
      await assert.rejects(resolvePersonDeletionTarget(options(root, [
        { id: "one", name: "one", folderPath },
        { id: "two", name: "two", folderPath: otherFolder },
      ])), { status: 409 });
    }
    assert.equal((await stat(folderPath)).isDirectory(), true);
  });
});

test("person deletion rejects junctions both in the target path and below it", async () => {
  await withFixture(async (root) => {
    const folderPath = path.join(root, "archive");
    const outside = path.join(root, "outside");
    await mkdir(folderPath);
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    const link = path.join(folderPath, "linked");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const person = { id: "one", name: "one", folderPath };
    await assert.rejects(deletePersonDirectory(options(root, [person])), { status: 400 });
    await assert.rejects(deletePersonDirectory(options(root, [{ ...person, folderPath: link }])), { status: 400 });
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
  });
});

test("delete API and two-step UI require explicit choices, honor cancellation, and preserve or delete files", async () => {
  await withFixture(async (root) => {
    const port = 48_000 + Math.floor(Math.random() * 5_000);
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, MEDIA_TRACKER_DATA_DIR: path.join(root, "data"), MEDIA_TRACKER_PORT: String(port), MEDIA_TRACKER_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let browser;
    try {
      const started = await waitForServiceStartup(child);
      assert.match(started, /已启动/);
      const headers = { Origin: origin, "Content-Type": "application/json" };
      // The server supplies the host system language, not just navigator.locale.
      const language = await fetch(`${origin}/api/settings`, { method: "PUT", headers,
        body: JSON.stringify({ language: "zh" }) });
      assert.equal(language.status, 200);
      assert.equal((await fetch(`${origin}/api/state`).then((response) => response.json())).settings.language, "zh");
      const people = [];
      for (const name of ["Keep person", "Delete person"]) {
        const response = await fetch(`${origin}/api/persons`, {
          method: "POST", headers,
          body: JSON.stringify({ name, folderMode: "new", selectedPath: path.join(root, "archive"), platforms: [{ id: "threads", accounts: [{ label: "test" }] }] }),
        });
        assert.equal(response.status, 201);
        const person = await response.json();
        await writeFile(path.join(person.folderPath, "manual.txt"), name);
        people.push(person);
      }
      const target = `${origin}/api/persons/${people[0].id}`;
      for (const value of [{}, { deleteFiles: "false" }, { deleteFiles: null }]) {
        const response = await fetch(target, { method: "DELETE", headers, body: JSON.stringify(value) });
        assert.equal(response.status, 400);
      }
      const stalePath = await fetch(target, { method: "DELETE", headers, body: JSON.stringify({ deleteFiles: true, expectedFolderPath: path.join(root, "old-folder") }) });
      assert.equal(stalePath.status, 409);
      browser = await chromium.launch({ headless: true });
      // This fixture asserts Chinese labels; do not inherit the host OS language.
      const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1100, height: 850 } });
      await page.goto(origin);
      const personCard = (name) => page.locator(".person-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
      const dialog = page.locator("#confirm-dialog");
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await personCard(people[0].name).locator(".delete-person").click();
        assert.equal(await page.locator("html").getAttribute("data-theme"), colorScheme);
        assert.equal(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor), colorScheme === "dark" ? "rgb(21, 30, 45)" : "rgb(255, 255, 255)");
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        assert.equal(await personCard(people[0].name).count(), 1);
      }
      await personCard(people[0].name).locator(".delete-person").click();
      await dialog.getByRole("button", { name: "确认删除人物", exact: true }).click();
      await dialog.getByRole("button", { name: "是，保留内容", exact: true }).waitFor();
      assert.equal(await page.locator("#confirm-path").textContent(), people[0].folderPath);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await personCard(people[0].name).count(), 1);
      assert.equal(await readFile(path.join(people[0].folderPath, "manual.txt"), "utf8"), people[0].name);
      const syncResponse = await fetch(`${target}/sync`, { method: "POST", headers });
      let job = await syncResponse.json();
      for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(job.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        job = await fetch(`${origin}/api/sync-jobs/${job.id}`).then((response) => response.json());
      }
      assert.equal(job.status, "completed");
      await personCard(people[0].name).locator(".delete-person").click();
      await dialog.getByRole("button", { name: "确认删除人物", exact: true }).click();
      const keepResponse = page.waitForResponse((response) => response.url() === target && response.request().method() === "DELETE");
      await dialog.getByRole("button", { name: "是，保留内容", exact: true }).click();
      const keep = await keepResponse;
      assert.equal(keep.status(), 200, await keep.text());
      assert.equal((await keep.json()).keptFiles, true);
      assert.equal(await readFile(path.join(people[0].folderPath, "manual.txt"), "utf8"), people[0].name);
      assert.equal((await fetch(`${origin}/api/sync-jobs/${job.id}`)).status, 404);
      assert.equal((await fetch(`${target}/new-files`)).status, 404);
      await personCard(people[0].name).waitFor({ state: "detached" });
      await personCard(people[1].name).locator(".delete-person").click();
      await dialog.getByRole("button", { name: "确认删除人物", exact: true }).click();
      const removeResponse = page.waitForResponse((response) => response.url() === `${origin}/api/persons/${people[1].id}` && response.request().method() === "DELETE");
      await dialog.getByRole("button", { name: "否，删除全部文件", exact: true }).click();
      const remove = await removeResponse;
      assert.equal(remove.status(), 200, await remove.text());
      await assert.rejects(stat(people[1].folderPath), { code: "ENOENT" });
      const state = await fetch(`${origin}/api/state`).then((response) => response.json());
      assert.equal(state.persons.length, 0);
    } finally {
      await browser?.close();
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit").catch(() => {});
      }
    }
  });
});
