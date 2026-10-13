import path from "node:path";
import { mkdir, writeFile, readFile, lstat, realpath } from "node:fs/promises";

// Only the bootstrap's own, nonce-bound control file may be acknowledged.
// This is not a generic write-file API, and contains no settings or account data.
export async function acknowledgeLauncherReady(dataDirectory, environment = process.env) {
  const filename = environment.MEDIA_TRACKER_READY_FILE;
  const token = environment.MEDIA_TRACKER_READY_TOKEN;
  if (!filename && !token) return false;
  if (!/^[a-f0-9]{32}$/.test(token || "") || !path.isAbsolute(filename || "")) {
    throw new Error("Invalid local compiler readiness controls.");
  }
  const directory = path.join(path.resolve(dataDirectory), "startup-logs");
  const expected = path.join(directory, `.ready-${token}.json`);
  if (path.resolve(filename).toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Local compiler readiness path is outside its control directory.");
  }
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) {
    throw new Error("Local compiler readiness directory is unsafe.");
  }
  const payload = { schemaVersion: 1, token, ready: true };
  try { await writeFile(expected, JSON.stringify(payload), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const marker = await lstat(expected);
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 1024) throw new Error("Local compiler readiness marker is unsafe.");
    if (JSON.stringify(JSON.parse(await readFile(expected, "utf8"))) !== JSON.stringify(payload)) {
      throw new Error("Local compiler readiness marker does not match this launch.");
    }
  }
  delete environment.MEDIA_TRACKER_READY_FILE;
  delete environment.MEDIA_TRACKER_READY_TOKEN;
  return true;
}
