import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { inspectMedia, similarityTools, compareMedia, choosePreferred, candidateMatch, verifyMediaPair, perceptualHash, hashDistance, SIMILARITY_VERSION } from "../lib/media-similarity.mjs";

const execute = promisify(execFile);
const pack = (data) => deflateSync(data).toString("base64");

function imageFingerprint(seed = 1) {
  const size = 32, gray = Buffer.alloc(size * size), color = Buffer.alloc(8 * 8 * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) gray[y * size + x] = (x * 5 + y * 2 + seed) % 180 + 30;
  for (let i = 0; i < color.length; i++) color[i] = (i * 3) % 190 + 20;
  return { version: SIMILARITY_VERSION, kind: "image", width: 640, height: 640, aspect: 1, duration: 0, fps: 0, complete: true, animated: false, audios: [], audio: null,
    visual: { encoding: "temporal-delta-v1", graySize: size, colorSize: 8, detailSize: size, frames: 1, sampleIndexes: [0], gray: pack(gray), color: pack(color), details: null,
      hashes: [perceptualHash(gray, size)], temporalMae: 0 }, quality: { pixels: 640 * 640, sharpness: 20, clippedFraction: .005, fps: 0 } };
}

test("perceptual hashes are only a candidate filter, not automatic proof", () => {
  const a = imageFingerprint(), b = structuredClone(a);
  assert.equal(hashDistance(a.visual.hashes[0], b.visual.hashes[0]), 0);
  assert.equal(hashDistance("invalid", b.visual.hashes[0]), 64);
  assert.equal(candidateMatch(a, b), true);
  b.complete = false;
  assert.equal(compareMedia(a, b).decision, "review");
  b.complete = true; b.visual.gray = "bad";
  assert.equal(compareMedia(a, b).decision, "review");
});

test("different color content cannot merge on identical luminance hash", () => {
  const a = imageFingerprint(), b = structuredClone(a);
  b.visual.color = pack(Buffer.alloc(8 * 8 * 3, 240));
  assert.equal(candidateMatch(a, b), true);
  assert.equal(compareMedia(a, b).decision, "different");
});

test("same normalized pixels merge; clear quality winner beats file byte size", () => {
  const a = imageFingerprint(), b = structuredClone(a);
  a.bytes = 900_000; b.bytes = 100_000;
  a.quality.jpeg = { luminanceQuantizationMean: 15 };
  b.quality.jpeg = { luminanceQuantizationMean: 6 };
  assert.equal(compareMedia(a, b).decision, "merge");
  assert.equal(choosePreferred(a, b).preferred, "right");
});

test("quality tradeoffs need review, semantic training fitness is not asserted", () => {
  const a = imageFingerprint(), b = structuredClone(a);
  b.quality.pixels *= 4; b.quality.sharpness *= .2;
  assert.equal(choosePreferred(a, b).preferred, null);
  assert.equal(choosePreferred(a, structuredClone(a)).preferred, "left");
});

test("localized watermark changes do not hide behind global similarity", () => {
  const a = imageFingerprint(), b = structuredClone(a), gray = Buffer.alloc(32 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) gray[y * 32 + x] = (x * 5 + y * 2 + 1) % 180 + 30;
  for (let y = 1; y < 4; y++) for (let x = 1; x < 5; x++) gray[y * 32 + x] = 250;
  b.visual.gray = pack(gray);
  assert.notEqual(compareMedia(a, b).decision, "merge");
});

test("GIF/animated media never merge from one frame", () => {
  const a = imageFingerprint(), b = structuredClone(a); b.animated = true;
  assert.equal(compareMedia(a, b).decision, "review");
});

test("cross kind, aspect, duration and unsupported fingerprints are not candidates", () => {
  const a = imageFingerprint(), b = structuredClone(a);
  b.kind = "video"; assert.equal(candidateMatch(a, b), false);
  b.kind = "image"; b.aspect = 1.1; assert.equal(candidateMatch(a, b), false);
  b.aspect = 1; b.version = 999; assert.equal(candidateMatch(a, b), false);
  a.kind = b.kind = "video"; b.version = 1; a.duration = 3; b.duration = 4;
  assert.equal(candidateMatch(a, b), false);
});

test("complete ordered sequence protects swapped or changed ending frames", () => {
  const a = imageFingerprint();
  a.kind = "video"; a.duration = .2; a.fps = 30; a.frameCount = 6;
  const frameBytes = a.visual.graySize ** 2, frames = [];
  for (let f = 0; f < 6; f++) {
    const frame = Buffer.alloc(frameBytes);
    for (let i = 0; i < frame.length; i++) frame[i] = (i * 3 + f * 14) % 200 + 20;
    frames.push(frame);
  }
  const delta = (buffer, stride) => { const out = Buffer.from(buffer); for (let i = out.length - 1; i >= stride; i--) out[i] = (buffer[i] - buffer[i - stride] + 256) & 255; return pack(out); };
  const set = (fp, ordered) => {
    fp.visual.frames = 6; fp.visual.temporalMae = 3;
    fp.visual.sampleIndexes = [0, 2, 5];
    fp.visual.gray = delta(Buffer.concat(ordered), frameBytes);
    fp.visual.color = delta(Buffer.alloc(6 * 8 * 8 * 3, 100), 8 * 8 * 3);
    fp.visual.details = delta(Buffer.concat([ordered[0], ordered[2], ordered[5]]), frameBytes);
    fp.visual.hashes = fp.visual.sampleIndexes.map((i) => perceptualHash(ordered[i], 32));
  };
  set(a, frames);
  const b = structuredClone(a), swapped = frames.slice(); [swapped[1], swapped[3]] = [swapped[3], swapped[1]]; set(b, swapped);
  assert.equal(candidateMatch(a, b), true);
  assert.notEqual(compareMedia(a, b).decision, "merge");
  const ending = frames.slice(); ending[5] = Buffer.alloc(frameBytes, 180); set(b, ending);
  assert.notEqual(compareMedia(a, b).decision, "merge");
});

test("equal mono audio cannot conceal different native stereo/high-frequency tracks", () => {
  const a = imageFingerprint(), b = structuredClone(a);
  const pcm = Buffer.alloc(2000);
  a.audios = b.audios = [{ channels: 2, sampleRate: 44100 }];
  a.audio = { sha256: "a".repeat(64), nativePcmHash: "b".repeat(64), rate: 4000, samples: 1000, pcm: pack(pcm) };
  b.audio = { ...a.audio, nativePcmHash: "c".repeat(64) };
  assert.equal(compareMedia(a, b).reason, "native-audio-needs-review");
});

test("inspectMedia rejects URLs, empty/missing/unsupported files and cancelled work", async () => {
  await assert.rejects(inspectMedia("https://example.com/media.jpg"), { code: "invalid-media-path" });
  await assert.rejects(inspectMedia(path.join(os.tmpdir(), "no-similarity-playlist.m3u8")), { code: "invalid-media-path" });
  await assert.rejects(inspectMedia(path.join(os.tmpdir(), "absent-local-similarity.jpg")), { code: "ENOENT" });
  const controller = new AbortController(); controller.abort(new Error("cancelled locally"));
  await assert.rejects(inspectMedia("https://example.com/media.jpg", { signal: controller.signal }), /cancelled locally/);
});

test("actual local ffmpeg fingerprints verify complete images/videos without network or visible windows", { timeout: 60_000 }, async (t) => {
  let tools;
  try { tools = await similarityTools(); } catch (error) { t.skip(error.message); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "media-similarity-test-"));
  const make = async (name, args) => {
    const file = path.join(directory, name);
    await execute(tools.ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-y", ...args, file], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
    return file;
  };
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const imageA = await make("a.png", ["-f", "lavfi", "-i", "testsrc2=size=160x240:rate=1", "-frames:v", "1", "-compression_level", "0"]);
  const imageB = await make("b.png", ["-i", imageA, "-frames:v", "1", "-compression_level", "9"]);
  const still = await Promise.all([inspectMedia(imageA, { kind: "image" }), inspectMedia(imageB, { kind: "image" })]);
  assert.notDeepEqual(await readFile(imageA), await readFile(imageB));
  assert.equal(still[0].complete, true); assert.equal(compareMedia(...still).decision, "merge");
  assert.equal((await verifyMediaPair(imageA, imageB, { kind: "image" })).decision, "merge");
  assert.ok(Buffer.byteLength(JSON.stringify(still[0])) <= 256 * 1024);
  assert.equal(still[0].qualityBasis, "local-training-proxy-not-model-evaluation");
  const videoA = await make("a.mp4", ["-f", "lavfi", "-i", "testsrc2=size=160x240:rate=12:duration=1", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
  const videoB = await make("b.mp4", ["-i", videoA, "-map", "0", "-c", "copy", "-metadata", "comment=different container, same full media"]);
  const videos = await Promise.all([inspectMedia(videoA, { kind: "video" }), inspectMedia(videoB, { kind: "video" })]);
  assert.equal(videos[0].complete, true); assert.equal(videos[0].frameCount, 12);
  assert.notDeepEqual(await readFile(videoA), await readFile(videoB));
  assert.equal(compareMedia(...videos).decision, "merge");
  const fullVerification = await verifyMediaPair(videoA, videoB, { kind: "video" });
  assert.equal(fullVerification.decision, "merge"); assert.equal(fullVerification.metrics.frames, 12);
  assert.equal(choosePreferred(...videos).preferred, "left");
  const trimmed = await make("trim.mp4", ["-i", videoA, "-t", "0.6", "-c", "copy"]);
  assert.notEqual(compareMedia(videos[0], await inspectMedia(trimmed, { kind: "video" })).decision, "merge");
  const audioDifferent = await make("audio.mp4", ["-i", videoA, "-f", "lavfi", "-i", "sine=frequency=700:duration=1", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest"]);
  assert.notEqual(compareMedia(videos[0], await inspectMedia(audioDifferent, { kind: "video" })).decision, "merge");
  assert.equal((await verifyMediaPair(videoA, audioDifferent, { kind: "video" })).reason, "native-audio-needs-review");
  const louder = await make("louder.mp4", ["-i", videoA, "-c:v", "copy", "-af", "volume=1.2", "-c:a", "aac"]);
  assert.notEqual(compareMedia(videos[0], await inspectMedia(louder, { kind: "video" })).decision, "merge");
  const watermark = await make("watermark.mp4", ["-i", videoA, "-vf", "drawbox=x=0:y=0:w=60:h=60:color=white:t=fill:enable='eq(n,6)'", "-c:v", "libx264", "-crf", "18", "-c:a", "copy"]);
  assert.notEqual(compareMedia(videos[0], await inspectMedia(watermark, { kind: "video" })).decision, "merge");
  const staticA = await make("static.mp4", ["-loop", "1", "-i", imageA, "-t", "1", "-r", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const staticB = await make("static-b.mp4", ["-i", staticA, "-c", "copy", "-metadata", "comment=static variant"]);
  assert.equal(compareMedia(await inspectMedia(staticA, { kind: "video" }), await inspectMedia(staticB, { kind: "video" })).reason, "static-video-needs-review");
  assert.equal((await verifyMediaPair(staticA, staticB, { kind: "video" })).reason, "static-video-needs-review");
  const gif = await make("animated.gif", ["-f", "lavfi", "-i", "testsrc2=size=80x80:rate=3:duration=1", "-loop", "0"]);
  const animation = await inspectMedia(gif, { kind: "image" });
  assert.equal(animation.complete, false); assert.equal(animation.reason, "animated-image-review");
  assert.equal((await verifyMediaPair(gif, gif, { kind: "image" })).reason, "animated-image-review");
  const subtleBase = await make("subtle-base.mp4", ["-f", "lavfi", "-i", "testsrc2=size=960x540:rate=24:duration=2", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p"]);
  const subtlePatch = await make("subtle-patch.mp4", ["-f", "lavfi", "-i", "testsrc2=size=960x540:rate=24:duration=2", "-vf", "drawbox=x=50:y=50:w=12:h=12:color=white:t=fill:enable='eq(n,4)'", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p"]);
  const subtleVerify = await verifyMediaPair(subtleBase, subtlePatch, { kind: "video" });
  assert.equal(subtleVerify.decision, "review"); assert.equal(subtleVerify.reason, "native-local-detail-differs");
  assert.ok(subtleVerify.metrics.frames <= 5);
  const overlayImage = await make("tiny-overlay.png", ["-i", imageA, "-vf", "drawbox=x=50:y=50:w=2:h=2:color=white:t=fill", "-frames:v", "1"]);
  assert.equal((await verifyMediaPair(imageA, overlayImage, { kind: "image" })).decision, "review");
  const maskedList = path.join(directory, "masked.jpg"); await writeFile(maskedList, "#EXTM3U\n#EXTINF:1\nhttps://example.com/never-connect.ts\n");
  await assert.rejects(inspectMedia(maskedList, { kind: "image" }), { code: "similarity-decode-failed" });
  const broken = path.join(directory, "broken.jpg"); await writeFile(broken, "not a picture");
  await assert.rejects(inspectMedia(broken, { kind: "image" }), { code: "similarity-decode-failed" });
  try {
    const linked = path.join(directory, "linked.png"); await symlink(imageA, linked);
    await assert.rejects(inspectMedia(linked, { kind: "image" }), { code: "invalid-media-path" });
  } catch (error) { if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error; }
  const source = await readFile(new URL("../lib/media-similarity.mjs", import.meta.url), "utf8");
  assert.match(source, /windowsHide: true, shell: false/);
  assert.match(source, /protocol_whitelist.*file,pipe/);
  assert.doesNotMatch(source, /\bfetch\s*\(|https:\/\/|openai|anthropic/i);
});

test("VFR timestamps preserve every frame without hiding real decode failures", { timeout: 60_000 }, async (t) => {
  let tools;
  try { tools = await similarityTools(); } catch (error) { t.skip(error.message); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "media-similarity-vfr-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const video = path.join(directory, "vfr.mp4");
  await execute(tools.ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=60:duration=2",
    "-vf", "settb=1/1000000,setpts='(floor(N/2)/30+mod(N,2)/1000)/TB'", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000",
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-video_track_timescale", "1000000", video],
  { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
  const common = ["-v", "error", "-nostdin", "-threads", "1", "-i", video, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-filter_threads", "1", "-vf", "scale=24:24:flags=area", "-fps_mode", "passthrough", "-pix_fmt", "gray"];
  const legacy = await execute(tools.ffmpeg, [...common, "-f", "rawvideo", "pipe:1"],
    { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: "buffer" });
  assert.match(legacy.stderr.toString(), /non monotonically increasing dts/);
  assert.equal(legacy.stdout.length, 120 * 24 * 24);
  const precise = await execute(tools.ffmpeg, [...common, "-enc_time_base", "1:1000000", "-f", "rawvideo", "pipe:1"],
    { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: "buffer" });
  assert.equal(precise.stderr.length, 0);
  assert.deepEqual(precise.stdout, legacy.stdout);
  const fingerprint = await inspectMedia(video, { kind: "video" });
  assert.equal(fingerprint.complete, true);
  assert.equal(fingerprint.frameCount, 120);
  const verification = await verifyMediaPair(video, video, { kind: "video" });
  assert.equal(verification.decision, "merge");
  assert.equal(verification.metrics.frames, 120);
  const truncated = path.join(directory, "truncated.mp4");
  const bytes = await readFile(video);
  await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await assert.rejects(inspectMedia(truncated, { kind: "video" }), { code: "similarity-decode-failed" });
  assert.notEqual((await verifyMediaPair(video, truncated, { kind: "video" })).decision, "merge");
});
