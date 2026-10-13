import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveReceiptFile } from "../lib/file-reveal.mjs";

const person = {
  folderPath: path.join(os.tmpdir(), "media-tracker-person"),
  platforms: [{
    id: "instagram",
    label: "Instagram",
    accounts: [{ id: "account-b", folderName: "账号 B" }],
  }],
};

test("receipt files resolve inside person media directories independent of source accounts", () => {
  const resolved = resolveReceiptFile(person, {
    platformId: "instagram",
    accountId: "account-b",
    relativePath: path.join("Image", "a.jpg"),
  });
  assert.equal(resolved, path.resolve(person.folderPath, "Image", "a.jpg"));
  assert.throws(() => resolveReceiptFile(person, {
    platformId: "instagram",
    accountId: "account-b",
    relativePath: path.join("..", "outside.jpg"),
  }), /不在人物/);
  assert.equal(resolveReceiptFile({ ...person, platforms: [] }, {
    platformId: "x",
    accountId: "account-b",
    relativePath: path.join("Image", "a.jpg"),
  }), path.resolve(person.folderPath, "Image", "a.jpg"));
});

test("renaming a custom platform does not change a shared asset path", () => {
  const customPerson = { ...person, platforms: [{ id: "custom-test", label: "新显示名称", folderName: "原目录",
    accounts: [{ id: "account-b", folderName: "账号 B" }] }] };
  assert.equal(resolveReceiptFile(customPerson, { platformId: "custom-test", accountId: "account-b", relativePath: "Video/old.mp4" }),
    path.resolve(person.folderPath, "Video", "old.mp4"));
});

test("indexed receipts use only the authoritative asset path, not receipt or client paths", () => {
  const mediaId = "a".repeat(64);
  const index = { get: (id) => id === mediaId ? { relativePath: "Image/saved.jpg" } : null };
  assert.equal(resolveReceiptFile(person, { mediaId, relativePath: "../outside" }, index),
    path.resolve(person.folderPath, "Image", "saved.jpg"));
  assert.throws(() => resolveReceiptFile(person, { mediaId: "missing" }, index), /记录已不存在/);
  for (const relativePath of ["Index/media-index.json", "X/A/Image/a.jpg", "Image/../outside.jpg",
    "Image/a.jpg:secret", "C:\\outside.jpg", "\\\\server\\share\\outside.jpg"]) {
    assert.throws(() => resolveReceiptFile(person, { relativePath }), /不在人物/);
  }
});

test("an indexed pending merge can open its recovered original but arbitrary archive paths are rejected", () => {
  const mediaId = "a".repeat(64);
  const relativePath = "Index/DedupArchive/11111111-1111-1111-1111-111111111111/saved.jpg";
  const index = { get: () => ({ mediaId, mergePending: true, relativePath }) };
  assert.equal(resolveReceiptFile(person, { mediaId }, index), path.resolve(person.folderPath, relativePath));
  assert.throws(() => resolveReceiptFile(person, { relativePath }), /不在人物/);
  assert.throws(() => resolveReceiptFile(person, { mediaId }, { get: () => ({ mediaId, relativePath }) }), /不在人物/);
  assert.throws(() => resolveReceiptFile(person, { mediaId }, { get: () => ({ mediaId, mergePending: true,
    relativePath: "Index/DedupArchive/11111111-1111-1111-1111-111111111111/../outside.jpg" }) }), /不在人物/);
});
