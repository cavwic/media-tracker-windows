import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const run = promisify(execFile);
const publicDirectory = path.resolve(import.meta.dirname, "../public");

test("native app favicon fixture exposes the site icon without a runtime icon helper", {
  skip: process.platform !== "win32" || process.env.MEDIA_TRACKER_NATIVE_ICON_TEST !== "1", timeout: 30_000,
}, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "collector-favicon-native-"));
  const captures = await mkdtemp(path.join(os.tmpdir(), "collector-favicon-captures-"));
  const index = await readFile(path.join(publicDirectory, "index.html"), "utf8");
  const iconLinks = index.match(/<link[^>]+rel="(?:alternate )?icon"[^>]+>/g);
  assert.ok(iconLinks?.length);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.url);
    if (["/media-tracker.svg", "/media-tracker-v2.ico"].includes(request.url)) {
      response.setHeader("Content-Type", request.url.endsWith(".ico") ? "image/x-icon" : "image/svg+xml");
      return response.end(await readFile(path.join(publicDirectory, request.url.slice(1))));
    }
    if (request.url === "/favicon.ico") { response.statusCode = 404; return response.end(); }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>Offline owned favicon fixture</title>${request.url.includes("icons=1") ? iconLinks.join("") : ""}</head><body>Native favicon fixture</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let context;
  t.after(async () => {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith("collector-favicon-native-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null,
    ignoreDefaultArgs: ["about:blank", "--enable-automation"],
    args: ["--no-first-run", "--disable-background-mode", `--app=${url}`],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  assert.equal(context.pages().length, 1);
  const page = context.pages()[0];
  const session = await context.browser().newBrowserCDPSession();
  const processInfo = (await session.send("SystemInfo.getProcessInfo")).processInfo.filter((entry) => entry.type === "browser");
  await session.detach();
  assert.equal(processInfo.length, 1);
  const processId = processInfo[0].id;
  assert.ok(Number.isSafeInteger(processId) && processId > 0);
  const inspect = async (captureLabel) => {
    // This is read-only and receives only this temporary browser's CDP PID.
    // No process search, WM_SETICON, focus change, or persisted window setting.
    const source = `$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing.dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class FixtureIconReader {
  private delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder value, int size);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr kind, IntPtr value, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] private static extern IntPtr GetClassLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadImage(IntPtr instance, string file, uint type, int cx, int cy, uint flags);
  [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
  private static string HashIcon(IntPtr handle, string capture) {
    if (handle == IntPtr.Zero) return "";
    using (Icon icon = Icon.FromHandle(handle)) using (Bitmap bitmap = icon.ToBitmap()) {
      if (capture != null) bitmap.Save(capture, System.Drawing.Imaging.ImageFormat.Png);
      var bytes = new List<byte>();
      for (int y = 0; y < bitmap.Height; y++) for (int x = 0; x < bitmap.Width; x++) {
        Color pixel = bitmap.GetPixel(x, y); bytes.Add(pixel.R); bytes.Add(pixel.G); bytes.Add(pixel.B); bytes.Add(pixel.A);
      }
      using (SHA256 sha = SHA256.Create()) return bitmap.Width + ":" + BitConverter.ToString(sha.ComputeHash(bytes.ToArray())).Replace("-", "").ToLowerInvariant();
    }
  }
  public static string[] Inspect(int expectedPid, string iconPath, string captures, string label) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr parameter) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid == (uint)expectedPid && IsWindowVisible(hwnd)) {
        var name = new StringBuilder(128); GetClassName(hwnd, name, name.Capacity);
        if (name.ToString() == "Chrome_WidgetWin_1") found.Add(hwnd);
      }
      return true;
    }, IntPtr.Zero);
    if (found.Count != 1) throw new InvalidOperationException("No unique fixture window.");
    var result = new List<string>();
    for (int kind = 0; kind < 3; kind++) {
      IntPtr handle;
      if (SendMessageTimeout(found[0], 0x7f, new IntPtr(kind), IntPtr.Zero, 2, 1000, out handle) == IntPtr.Zero) throw new InvalidOperationException("Fixture window did not respond.");
      result.Add(HashIcon(handle, System.IO.Path.Combine(captures, label + "-wm-" + kind + ".png")));
    }
    result.Add(HashIcon(GetClassLongPtr(found[0], -34), System.IO.Path.Combine(captures, label + "-class-small.png")));
    result.Add(HashIcon(GetClassLongPtr(found[0], -14), System.IO.Path.Combine(captures, label + "-class-large.png")));
    foreach (int size in new int[] { 16, 24, 32, 48, 64 }) {
      IntPtr loaded = LoadImage(IntPtr.Zero, iconPath, 1, size, size, 0x10);
      try { result.Add(HashIcon(loaded, null)); } finally { if (loaded != IntPtr.Zero) DestroyIcon(loaded); }
    }
    return result.ToArray();
  }
}
'@
[FixtureIconReader]::Inspect(${processId}, '${path.join(publicDirectory, "media-tracker-v2.ico").replaceAll("'", "''")}', '${captures.replaceAll("'", "''")}', '${captureLabel}') | ConvertTo-Json -Compress`;
    return JSON.parse((await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64")], { windowsHide: true, timeout: 12_000 })).stdout.trim());
  };
  const baseline = await inspect("baseline");
  await page.goto(`${url}?icons=1`, { waitUntil: "networkidle" });
  const withIcon = await inspect("favicon");
  t.diagnostic(JSON.stringify({ baseline: baseline.slice(0, 5), withIcon: withIcon.slice(0, 5),
    captures,
    matchesIcoAsset: withIcon.slice(0, 5).some((hash) => hash && withIcon.slice(5).includes(hash)),
    nativeIconChanged: JSON.stringify(baseline.slice(0, 5)) !== JSON.stringify(withIcon.slice(0, 5)),
    siteIconRequested: requests.includes("/media-tracker.svg") || requests.includes("/media-tracker-v2.ico") }));
  assert.ok(requests.includes("/media-tracker.svg") || requests.includes("/media-tracker-v2.ico"));
  assert.ok(withIcon[0] && withIcon[1] && withIcon[2], "All three native window icon queries must be readable.");
  assert.notEqual(withIcon[0], baseline[0], "Favicon must replace the default native small icon.");
  assert.notEqual(withIcon[1], baseline[1], "Favicon must replace the default native large/taskbar icon.");
  assert.equal(withIcon[2], withIcon[0], "WM_GETICON ICON_SMALL2 must resolve to the actual site small icon.");
  assert.deepEqual(withIcon.slice(3, 5), baseline.slice(3, 5), "No class-level Chromium resources should be modified.");
  assert.equal(page.isClosed(), false);
});
