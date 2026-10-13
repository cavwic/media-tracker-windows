import path from "node:path";
import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { checkDedupTools } from "./dedup-tools.mjs";

// This is intentionally not a semantic model or a LoRA fitness evaluation.
// Only very close, complete, ordered decoded content can be automatically merged.
export const SIMILARITY_VERSION = 1;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_OUTPUT = 48 * 1024 * 1024;
const VIDEO_GRAY = 24, VIDEO_COLOR = 8, DETAIL_SIZE = 64, DETAIL_FRAMES = 16;
const IMAGE_GRAY = 256, IMAGE_COLOR = 64;
const LOCAL_FORMATS = "mov,matroska,webm,avi,mpeg,mpegvideo,jpeg_pipe,png_pipe,bmp_pipe,tiff_pipe,webp_pipe,gif,apng";
const inputFormat = (filePath) => [".jpg", ".jpeg"].includes(path.extname(filePath).toLowerCase()) ? ["-f", "jpeg_pipe"] : [];
const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".mpeg", ".mpg", ".3gp"]);
const STILL_EXTENSIONS = new Set([".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif"]);
let active = 0;
const waiters = [];

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function aborted(signal) { signal?.throwIfAborted(); }

async function withSlot(signal, operation) {
  aborted(signal);
  if (active >= 2) await new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, cancel: null };
    entry.cancel = () => { const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1); reject(signal.reason || failure("cancelled", "本地媒体分析已取消。")); };
    signal?.addEventListener("abort", entry.cancel, { once: true });
    waiters.push(entry);
  });
  else active++;
  try { aborted(signal); return await operation(); }
  finally {
    const next = waiters.shift();
    if (next) { next.signal?.removeEventListener("abort", next.cancel); next.resolve(); }
    else active--;
  }
}

export async function similarityTools(options = {}) { return checkDedupTools(options); }

function run(executablePath, args, { signal, timeout = 90_000, maxOutput = MAX_OUTPUT } = {}) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, errorBytes = 0, settled = false, cancellation;
    const chunks = [], errors = [];
    const stop = (error) => { cancellation ||= error; child.kill(); };
    const onAbort = () => stop(signal.reason || failure("cancelled", "本地媒体分析已取消。"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(failure("similarity-timeout", "本地媒体解码超时；保留原文件并转为待检查。")), timeout);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxOutput) stop(failure("similarity-limit", "媒体超出安全分析上限；保留原文件并转为待检查。")); else chunks.push(chunk); });
    child.stderr.on("data", (chunk) => { errorBytes += chunk.length; if (errorBytes <= 16_384) errors.push(chunk); });
    const finish = (error, output) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve(output);
    };
    child.once("error", () => finish(failure("similarity-process-failed", "本地解码工具无法运行；保留原文件。")));
    child.once("close", (code) => {
      if (cancellation) return finish(cancellation);
      // Do not persist ffmpeg stderr: it can contain file paths or URL metadata.
      if (code !== 0 || errorBytes) return finish(failure("similarity-decode-failed", "媒体未能完整解码；保留原文件并转为待检查。"));
      finish(null, Buffer.concat(chunks));
    });
  });
}

const rational = (value) => { const [a, b = 1] = String(value || "0").split("/").map(Number); return Number.isFinite(a / b) ? a / b : 0; };
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
function pack(buffer, stride = 0) {
  if (!stride) return deflateSync(buffer, { level: 6 }).toString("base64");
  const delta = Buffer.from(buffer);
  for (let i = delta.length - 1; i >= stride; i--) delta[i] = (buffer[i] - buffer[i - stride] + 256) & 255;
  return deflateSync(delta, { level: 6 }).toString("base64");
}
function unpack(value, expected, stride = 0) {
  if (typeof value !== "string" || value.length > MAX_JSON_BYTES * 2) throw failure("invalid-fingerprint", "媒体指纹损坏。");
  const buffer = inflateSync(Buffer.from(value, "base64"), { maxOutputLength: MAX_OUTPUT });
  if (expected !== undefined && buffer.length !== expected) throw failure("invalid-fingerprint", "媒体指纹长度不符。");
  if (stride) for (let i = stride; i < buffer.length; i++) buffer[i] = (buffer[i] + buffer[i - stride]) & 255;
  return buffer;
}
function hash(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

function nearestGray(frame, size, target = 32) {
  const result = new Uint8Array(target * target);
  for (let y = 0; y < target; y++) for (let x = 0; x < target; x++) result[y * target + x] = frame[Math.min(size - 1, Math.floor((y + .5) * size / target)) * size + Math.min(size - 1, Math.floor((x + .5) * size / target))];
  return result;
}

export function perceptualHash(frame, size) {
  const input = nearestGray(frame, size), values = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let sum = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) sum += input[y * 32 + x] * Math.cos((2 * x + 1) * u * Math.PI / 64) * Math.cos((2 * y + 1) * v * Math.PI / 64);
    values.push(sum);
  }
  const sorted = values.slice(1).sort((a, b) => a - b), median = sorted[31];
  let bits = 0n;
  for (let i = 1; i < 64; i++) if (values[i] > median) bits |= 1n << BigInt(i - 1);
  return bits.toString(16).padStart(16, "0");
}

export function hashDistance(left, right) {
  if (!/^[a-f0-9]{16}$/.test(left || "") || !/^[a-f0-9]{16}$/.test(right || "")) return 64;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`), count = 0;
  while (value) { value &= value - 1n; count++; }
  return count;
}

function qualityMetrics(gray, size) {
  let mean = 0, clip = 0, sum = 0, square = 0, count = 0;
  for (const value of gray) { mean += value; if (value <= 2 || value >= 253) clip++; }
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const i = y * size + x, laplace = gray[i - 1] + gray[i + 1] + gray[i - size] + gray[i + size] - 4 * gray[i];
    sum += laplace; square += laplace * laplace; count++;
  }
  return { sharpness: Math.max(0, square / count - (sum / count) ** 2), clippedFraction: clip / gray.length, meanLuminance: mean / gray.length };
}

// JPEG DQT is a compression proxy, not an authenticity/original-file detector.
async function jpegQuality(filePath) {
  const descriptor = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(128 * 1024), { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let cursor = 2;
    while (cursor + 4 <= bytesRead) {
      if (bytes[cursor++] !== 0xff) return null;
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (cursor + 2 > bytesRead) break;
      const length = bytes.readUInt16BE(cursor), end = cursor + length;
      if (length < 2 || end > bytesRead) break;
      if (marker === 0xdb) for (let p = cursor + 2; p < end;) {
        const spec = bytes[p++], precision = spec >> 4, id = spec & 15, step = precision ? 2 : 1;
        if (precision > 1 || p + 64 * step > end) return null;
        let sum = 0;
        for (let i = 0; i < 64; i++, p += step) sum += precision ? bytes.readUInt16BE(p) : bytes[p];
        if (id === 0) return { luminanceQuantizationMean: sum / 64 };
      }
      cursor = end;
    }
    return null;
  } finally { await descriptor.close(); }
}

function difference(a, b, size, { tile = 4 } = {}) {
  if (a.length !== b.length || !a.length) return null;
  let absolute = 0, square = 0, max = 0, changed = 0, sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
  const tiles = new Float64Array(Math.ceil(size / tile) ** 2), counts = new Uint32Array(tiles.length), tileColumns = Math.ceil(size / tile);
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]); absolute += d; square += d * d; max = Math.max(max, d); if (d > 14) changed++;
    sumA += a[i]; sumB += b[i]; sumAA += a[i] * a[i]; sumBB += b[i] * b[i]; sumAB += a[i] * b[i];
    const t = Math.floor(Math.floor(i / size) / tile) * tileColumns + Math.floor((i % size) / tile); tiles[t] += d; counts[t]++;
  }
  const n = a.length, ma = sumA / n, mb = sumB / n, va = sumAA / n - ma * ma, vb = sumBB / n - mb * mb, cov = sumAB / n - ma * mb;
  const ssim = ((2 * ma * mb + 6.5025) * (2 * cov + 58.5225)) / ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225));
  return { mae: absolute / n, rmse: Math.sqrt(square / n), max, changedFraction: changed / n, ssim,
    maxTileMae: Math.max(...tiles.map((v, i) => v / counts[i])) };
}

function colorDifference(left, right) {
  if (left.length !== right.length || !left.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.abs(left[i] - right[i]);
  return sum / left.length;
}

async function probe(filePath, tools, signal) {
  const raw = await run(tools.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", LOCAL_FORMATS, "-show_entries",
    "stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,nb_frames,sample_rate,channels:format=duration,format_name", "-of", "json", ...inputFormat(filePath), filePath], { signal, timeout: 25_000, maxOutput: 256 * 1024 });
  let result;
  try { result = JSON.parse(raw); } catch { throw failure("similarity-probe-failed", "无法读取本地媒体格式；保留原文件。"); }
  const videos = (result.streams || []).filter((s) => s.codec_type === "video"), audios = (result.streams || []).filter((s) => s.codec_type === "audio");
  if (videos.length !== 1 || !positive(videos[0].width) || !positive(videos[0].height)) throw failure("similarity-unsupported", "媒体包含未知或多个视频画面流；保留原文件并转为待检查。");
  const stream = videos[0];
  return { width: Number(stream.width), height: Number(stream.height), aspect: Number(stream.width) / Number(stream.height),
    fps: rational(stream.avg_frame_rate) || rational(stream.r_frame_rate), duration: positive(stream.duration) || positive(result.format?.duration),
    declaredFrames: positive(stream.nb_frames), codec: stream.codec_name, audios: audios.map((a) => ({ channels: positive(a.channels), sampleRate: positive(a.sample_rate), codec: a.codec_name, duration: positive(a.duration) })) };
}

function decodeArgs(filePath, filter, outputFormat, extras = []) {
  return ["-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", LOCAL_FORMATS, ...inputFormat(filePath), "-i", filePath,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-filter_threads", "1", "-vf", filter, "-fps_mode", "passthrough", ...extras, "-pix_fmt", outputFormat,
    // Preserve source PTS precision when rawvideo assigns output timestamps.
    // The default average-frame-rate time base rounds valid VFR frames onto
    // the same tick and emits a muxer error despite decoding every frame.
    // Do not ignore decoder stderr or resample/drop frames to hide that error.
    "-enc_time_base", "1:1000000", "-f", "rawvideo", "pipe:1"];
}

async function nativeAudioHash(filePath, tools, signal) {
  const output = await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", LOCAL_FORMATS, "-i", filePath,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "pcm_s16le", "-f", "hash", "-hash", "sha256", "pipe:1"], { signal, maxOutput: 1024 });
  const match = output.toString("utf8").trim().match(/^SHA256=([a-f0-9]{64})$/);
  if (!match) throw failure("similarity-incomplete-audio", "完整音轨验证失败；保留原文件。");
  return match[1];
}

export async function inspectMedia(filePath, { kind, signal } = {}) {
  return withSlot(signal, async () => {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0") || !EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw failure("invalid-media-path", "仅分析已归档的本地媒体文件。");
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) throw failure("invalid-media-path", "媒体不存在、为空或不是普通文件。");
    const tools = await similarityTools(), metadata = await probe(filePath, tools, signal), extension = path.extname(filePath).toLowerCase();
    kind = kind === "video" || ![...STILL_EXTENSIONS, ".png", ".gif", ".webp"].includes(extension) ? "video" : "image";
    const animated = kind === "image" && (!STILL_EXTENSIONS.has(extension) && (metadata.duration > 0 || metadata.declaredFrames > 1 || extension === ".gif" || metadata.codec === "apng"));
    const base = { version: SIMILARITY_VERSION, kind, width: metadata.width, height: metadata.height, aspect: metadata.aspect,
      duration: kind === "video" || animated ? metadata.duration : 0, fps: kind === "video" ? metadata.fps : 0, animated,
      bytes: before.size, mtimeMs: before.mtimeMs, complete: false, qualityBasis: "local-training-proxy-not-model-evaluation", audios: metadata.audios };
    if (animated) return { ...base, reason: "animated-image-review", quality: { pixels: metadata.width * metadata.height } };
    if (kind === "video" && (metadata.duration <= 0 || metadata.duration > 90 || metadata.fps <= 0 || metadata.fps > 65 || metadata.audios.length > 1 || metadata.audios.some((a) => a.channels > 2))) return { ...base, reason: "full-sequence-limit", quality: { pixels: metadata.width * metadata.height, fps: metadata.fps } };
    const graySize = kind === "image" ? IMAGE_GRAY : VIDEO_GRAY, colorSize = kind === "image" ? IMAGE_COLOR : VIDEO_COLOR;
    const framesOption = kind === "image" ? ["-frames:v", "1"] : [];
    const gray = await run(tools.ffmpeg, decodeArgs(filePath, `scale=${graySize}:${graySize}:flags=area`, "gray", framesOption), { signal });
    const color = await run(tools.ffmpeg, decodeArgs(filePath, `scale=${colorSize}:${colorSize}:flags=area`, "rgb24", framesOption), { signal });
    const frameBytes = graySize * graySize, frames = gray.length / frameBytes;
    if (!Number.isSafeInteger(frames) || frames < 1 || color.length !== frames * colorSize * colorSize * 3 || (kind === "image" && frames !== 1)
      || (metadata.declaredFrames && Math.abs(metadata.declaredFrames - frames) > 0)) throw failure("similarity-incomplete-decode", "媒体完整帧数不一致；保留原文件并转为待检查。");
    const sampleIndexes = [...new Set(Array.from({ length: Math.min(DETAIL_FRAMES, frames) }, (_, i) => Math.round(i * (frames - 1) / (Math.min(DETAIL_FRAMES, frames) - 1 || 1))))];
    let details = kind === "image" ? gray : null;
    if (kind === "video") {
      const expression = sampleIndexes.map((index) => `eq(n\\,${index})`).join("+");
      details = await run(tools.ffmpeg, decodeArgs(filePath, `select='${expression}',scale=${DETAIL_SIZE}:${DETAIL_SIZE}:flags=area`, "gray"), { signal });
      if (details.length !== sampleIndexes.length * DETAIL_SIZE * DETAIL_SIZE) throw failure("similarity-incomplete-decode", "媒体细节帧解码不完整；保留原文件。");
    }
    const detailSize = kind === "image" ? IMAGE_GRAY : DETAIL_SIZE, qualities = sampleIndexes.map((_, i) => qualityMetrics(details.subarray(i * detailSize * detailSize, (i + 1) * detailSize * detailSize), detailSize));
    const quality = { pixels: metadata.width * metadata.height, fps: base.fps,
      sharpness: qualities.reduce((n, q) => n + q.sharpness, 0) / qualities.length,
      clippedFraction: qualities.reduce((n, q) => n + q.clippedFraction, 0) / qualities.length,
      meanLuminance: qualities.reduce((n, q) => n + q.meanLuminance, 0) / qualities.length,
      ...(kind === "image" && [".jpg", ".jpeg"].includes(extension) ? { jpeg: await jpegQuality(filePath) } : {}) };
    let temporalMae = 0;
    for (let f = 1; f < frames; f++) temporalMae += colorDifference(gray.subarray((f - 1) * frameBytes, f * frameBytes), gray.subarray(f * frameBytes, (f + 1) * frameBytes));
    temporalMae /= Math.max(1, frames - 1);
    let audio = null;
    if (metadata.audios.length) {
      const pcm = await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", LOCAL_FORMATS, "-i", filePath,
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "4000", "-f", "s16le", "pipe:1"], { signal, maxOutput: 2 * 1024 * 1024 });
      if (!pcm.length || pcm.length % 2) throw failure("similarity-incomplete-audio", "音轨未能完整解码；保留原文件。");
      // Downmixed/low-rate PCM alone could hide changed stereo channels or high frequencies.
      // Native-rate all-channel decoded PCM must also agree before automatic audio merge.
      audio = { rate: 4000, samples: pcm.length / 2, sha256: hash(pcm), nativePcmHash: await nativeAudioHash(filePath, tools, signal), pcm: pack(pcm) };
    }
    const after = await lstat(filePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw failure("media-changed-during-analysis", "分析过程中媒体发生变化，请稍后重试。");
    const visual = { encoding: "temporal-delta-v1", graySize, colorSize, frames, gray: pack(gray, frameBytes), color: pack(color, colorSize * colorSize * 3), detailSize, sampleIndexes,
      details: kind === "image" ? null : pack(details, detailSize * detailSize),
      temporalMae, decodedSha256: hash(gray), hashes: sampleIndexes.map((index) => perceptualHash(gray.subarray(index * frameBytes, (index + 1) * frameBytes), graySize)) };
    const result = { ...base, frameCount: frames, complete: true, visual, audio, quality };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON_BYTES) return { ...base, frameCount: frames, reason: "fingerprint-size-limit", fingerprintBytes: Buffer.byteLength(JSON.stringify(result)), quality,
      visual: { hashes: visual.hashes, temporalMae, frames }, audio: audio ? { sha256: audio.sha256, nativePcmHash: audio.nativePcmHash, rate: audio.rate, samples: audio.samples } : null };
    return result;
  });
}

export function candidateMatch(left, right) {
  if (!left || !right || left.version !== SIMILARITY_VERSION || right.version !== SIMILARITY_VERSION || left.kind !== right.kind) return false;
  if (!positive(left.aspect) || !positive(right.aspect) || Math.abs(left.aspect / right.aspect - 1) > .012) return false;
  if (left.kind === "video" && (!positive(left.duration) || !positive(right.duration) || Math.abs(left.duration - right.duration) > Math.max(.12, Math.min(left.duration, right.duration) * .012))) return false;
  const a = left.visual?.hashes, b = right.visual?.hashes;
  if (!a?.length || !b?.length) return false;
  if (left.kind === "image") return hashDistance(a[0], b[0]) <= 10;
  return [0, Math.floor((a.length - 1) / 2), a.length - 1].every((i, slot) => hashDistance(a[i], b[[0, Math.floor((b.length - 1) / 2), b.length - 1][slot]]) <= 12);
}

function audioComparison(left, right) {
  if (!!left.audio !== !!right.audio || left.audios?.length !== right.audios?.length) return { same: false, reason: "audio-content-differs" };
  if (!left.audio) return { same: true, correlation: 1, nrmse: 0 };
  if (left.audios[0]?.channels !== right.audios[0]?.channels) return { same: false, reason: "audio-channel-differs" };
  const nativeEqual = /^[a-f0-9]{64}$/.test(left.audio.nativePcmHash || "") && left.audio.nativePcmHash === right.audio.nativePcmHash
    && left.audios[0]?.sampleRate === right.audios[0]?.sampleRate;
  if (left.audio.sha256 === right.audio.sha256) return { same: nativeEqual, correlation: 1, nrmse: 0, ...(nativeEqual ? {} : { reason: "native-audio-needs-review" }) };
  const a = unpack(left.audio.pcm, left.audio.samples * 2), b = unpack(right.audio.pcm, right.audio.samples * 2), n = Math.min(left.audio.samples, right.audio.samples);
  if (Math.abs(left.audio.samples - right.audio.samples) > 400 || n < 400) return { same: false, reason: "audio-length-differs" };
  let best = { correlation: -1, nrmse: Infinity, gain: Infinity, lag: 0 };
  function alignment(lag) {
    const startA = Math.max(0, -lag), startB = Math.max(0, lag), count = Math.min(left.audio.samples - startA, right.audio.samples - startB);
    let aa = 0, bb = 0, ab = 0, dd = 0;
    for (let i = 0; i < count; i++) { const x = a.readInt16LE((i + startA) * 2), y = b.readInt16LE((i + startB) * 2); aa += x * x; bb += y * y; ab += x * y; dd += (x - y) ** 2; }
    const correlation = aa && bb ? ab / Math.sqrt(aa * bb) : aa === bb ? 1 : 0;
    return { correlation, nrmse: Math.sqrt(dd / Math.max(1, aa)), gain: Math.sqrt(bb / Math.max(1, aa)), lag };
  }
  for (let lag = -200; lag <= 200; lag += 4) { const trial = alignment(lag); if (trial.correlation > best.correlation) best = trial; }
  const coarseLag = best.lag;
  for (let lag = Math.max(-200, coarseLag - 3); lag <= Math.min(200, coarseLag + 3); lag++) { const trial = alignment(lag); if (trial.correlation > best.correlation) best = trial; }
  return { ...best, same: nativeEqual && best.correlation >= .998 && best.nrmse <= .085 && best.gain >= .96 && best.gain <= 1.04,
    ...(nativeEqual ? {} : { reason: "native-audio-needs-review" }) };
}

export function compareMedia(left, right) {
  const answer = (decision, reason, metrics = {}) => ({ decision, reason, metrics });
  if (!candidateMatch(left, right)) return answer("different", "candidate-content-differs");
  if (!left.complete || !right.complete || left.animated || right.animated) return answer("review", "complete-content-required");
  if (Math.abs(left.aspect / right.aspect - 1) > .003) return answer("review", "crop-or-aspect-differs");
  try {
    const lv = left.visual, rv = right.visual;
    if (!lv || !rv || lv.graySize !== rv.graySize || lv.colorSize !== rv.colorSize || lv.detailSize !== rv.detailSize) return answer("review", "incompatible-fingerprint");
    if (left.kind === "video") {
      if (lv.frames < 3 || rv.frames < 3 || lv.frames !== rv.frames || Math.abs(left.duration - right.duration) > Math.max(.04, 1 / Math.max(left.fps, right.fps))
        || Math.abs(left.fps / right.fps - 1) > .002) return answer("review", "video-timing-or-frame-count-differs");
      if (lv.temporalMae < .35 || rv.temporalMae < .35) return answer("review", "static-video-needs-review");
      if (JSON.stringify(lv.sampleIndexes) !== JSON.stringify(rv.sampleIndexes)) return answer("review", "frame-alignment-differs");
    }
    if (lv.encoding !== "temporal-delta-v1" || rv.encoding !== "temporal-delta-v1") return answer("review", "incompatible-fingerprint");
    const ga = unpack(lv.gray, lv.frames * lv.graySize ** 2, lv.graySize ** 2), gb = unpack(rv.gray, rv.frames * rv.graySize ** 2, rv.graySize ** 2);
    const ca = unpack(lv.color, lv.frames * lv.colorSize ** 2 * 3, lv.colorSize ** 2 * 3), cb = unpack(rv.color, rv.frames * rv.colorSize ** 2 * 3, rv.colorSize ** 2 * 3);
    const da = left.kind === "image" ? ga : unpack(lv.details, lv.sampleIndexes.length * lv.detailSize ** 2, lv.detailSize ** 2),
      db = right.kind === "image" ? gb : unpack(rv.details, rv.sampleIndexes.length * rv.detailSize ** 2, rv.detailSize ** 2);
    let minSsim = 1, maxMae = 0, maxTileMae = 0, maxChangedFraction = 0, maxPixel = 0;
    for (let frame = 0; frame < lv.frames; frame++) {
      const n = lv.graySize ** 2, metrics = difference(ga.subarray(frame * n, (frame + 1) * n), gb.subarray(frame * n, (frame + 1) * n), lv.graySize);
      minSsim = Math.min(minSsim, metrics.ssim); maxMae = Math.max(maxMae, metrics.mae); maxTileMae = Math.max(maxTileMae, metrics.maxTileMae); maxChangedFraction = Math.max(maxChangedFraction, metrics.changedFraction); maxPixel = Math.max(maxPixel, metrics.max);
    }
    let minDetailSsim = 1, maxDetailTileMae = 0, maxDetailChangedFraction = 0;
    for (let frame = 0; frame < lv.sampleIndexes.length; frame++) {
      const n = lv.detailSize ** 2, metrics = difference(da.subarray(frame * n, (frame + 1) * n), db.subarray(frame * n, (frame + 1) * n), lv.detailSize, { tile: left.kind === "image" ? 8 : 4 });
      minDetailSsim = Math.min(minDetailSsim, metrics.ssim); maxDetailTileMae = Math.max(maxDetailTileMae, metrics.maxTileMae); maxDetailChangedFraction = Math.max(maxDetailChangedFraction, metrics.changedFraction);
    }
    const colorMae = colorDifference(ca, cb), audio = audioComparison(left, right);
    const metrics = { minSsim, minDetailSsim, maxMae, maxTileMae, maxChangedFraction, maxPixel, maxDetailTileMae, maxDetailChangedFraction, colorMae, audio };
    if (minSsim < .9 || minDetailSsim < .9 || maxMae > 15 || colorMae > 14) return answer("different", "decoded-content-differs", metrics);
    if (!audio.same) return answer("review", audio.reason || "audio-needs-review", metrics);
    // Localized changes (text, logos, different face details) cannot be hidden by a high global SSIM.
    if (minSsim < .997 || minDetailSsim < .996 || maxMae > 2.1 || maxTileMae > 6 || maxPixel > 25
      || maxChangedFraction > .002 || maxDetailTileMae > 8 || maxDetailChangedFraction > .003 || colorMae > 3.2) return answer("review", "local-detail-or-compression-needs-review", metrics);
    return answer("merge", "near-identical-complete-decoded-content", metrics);
  } catch { return answer("review", "invalid-or-incomplete-fingerprint"); }
}

export function choosePreferred(left, right) {
  const result = (preferred, reason) => ({ preferred, reason, quality: { left: left?.quality || null, right: right?.quality || null } });
  const comparison = compareMedia(left, right);
  if (comparison.decision !== "merge") return result(null, "content-not-confirmed-identical");
  const a = left.quality, b = right.quality;
  if (!a || !b || !positive(a.pixels) || !positive(b.pixels) || !Number.isFinite(a.sharpness) || !Number.isFinite(b.sharpness)) return result(null, "quality-evidence-insufficient");
  function dominates(x, y, mediaX, mediaY) {
    if (x.pixels < y.pixels * .998 || (mediaX.kind === "video" && x.fps < y.fps * .998)
      || x.clippedFraction > y.clippedFraction + .004 || x.sharpness < y.sharpness * .92) return false;
    if (mediaX.audios?.length !== mediaY.audios?.length || (mediaX.audios?.length && (mediaX.audios[0].channels < mediaY.audios[0].channels || mediaX.audios[0].sampleRate < mediaY.audios[0].sampleRate))) return false;
    const quantX = positive(x.jpeg?.luminanceQuantizationMean), quantY = positive(y.jpeg?.luminanceQuantizationMean);
    return x.pixels > y.pixels * 1.08 || x.fps > y.fps * 1.04 || x.sharpness > y.sharpness * 1.04
      || x.clippedFraction < y.clippedFraction - .001 || (quantX && quantY && quantX < quantY * .82);
  }
  const aBetter = dominates(a, b, left, right), bBetter = dominates(b, a, right, left);
  if (aBetter !== bBetter) return result(aBetter ? "left" : "right", "resolution-detail-compression-dominance");
  // Stable tie is safe only if proxies are virtually indistinguishable; keep the established canonical file.
  if (Math.abs(a.pixels / b.pixels - 1) < .002 && Math.abs(a.sharpness - b.sharpness) <= Math.max(.2, Math.min(a.sharpness, b.sharpness) * .015)
    && Math.abs(a.clippedFraction - b.clippedFraction) < .001 && (left.kind !== "video" || Math.abs(a.fps - b.fps) < .01)) return result("left", "indistinguishable-quality-preserve-canonical");
  return result(null, "quality-tradeoff-needs-review");
}

function frameStream(executablePath, args, frameBytes, signal) {
  aborted(signal);
  const child = spawn(executablePath, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stopped = null, errorBytes = 0, settled = false;
  const stop = (error = failure("similarity-verification-stopped", "本地完整比对已停止。")) => {
    stopped ||= error;
    if (!settled) { child.kill(); child.stdout.destroy(); child.stderr.destroy(); }
  };
  const onAbort = () => stop(signal.reason || failure("cancelled", "本地媒体分析已取消。"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(failure("similarity-timeout", "原生分辨率完整比对超时；保留原文件。")), 120_000);
  child.stderr.on("data", (chunk) => { errorBytes += chunk.length; });
  const done = new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    child.once("error", () => finish(failure("similarity-process-failed", "完整比对解码工具无法运行。")));
    child.once("close", (code) => finish(stopped || (code !== 0 || errorBytes ? failure("similarity-decode-failed", "媒体未能完整解码；保留原文件。") : null)));
  });
  void done.catch(() => {});
  async function* frames() {
    let frame = Buffer.allocUnsafe(frameBytes), used = 0;
    for await (const chunk of child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        const count = Math.min(frameBytes - used, chunk.length - offset);
        chunk.copy(frame, used, offset, offset + count); used += count; offset += count;
        if (used === frameBytes) { yield frame; frame = Buffer.allocUnsafe(frameBytes); used = 0; }
      }
    }
    await done;
    if (used) throw failure("similarity-incomplete-decode", "完整比对发现残缺画面帧；保留原文件。");
  }
  return { frames: frames(), done, stop };
}

function nativeFrameDifference(left, right, width, height) {
  const tile = 8, columns = Math.ceil(width / tile), rows = Math.ceil(height / tile), sums = new Float64Array(columns * rows), counts = new Uint16Array(columns * rows);
  let sum = 0, maximum = 0, changed = 0, alphaChanged = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x, i = pixel * 4;
    const red = Math.abs(left[i] - right[i]), green = Math.abs(left[i + 1] - right[i + 1]), blue = Math.abs(left[i + 2] - right[i + 2]);
    const delta = (red + green + blue) / 3, largest = Math.max(red, green, blue);
    if (left[i + 3] !== right[i + 3]) alphaChanged++;
    if (largest > 32) changed++;
    sum += delta; maximum = Math.max(maximum, largest);
    const index = Math.floor(y / tile) * columns + Math.floor(x / tile); sums[index] += delta; counts[index]++;
  }
  let maxTileMae = 0;
  for (let i = 0; i < sums.length; i++) maxTileMae = Math.max(maxTileMae, sums[i] / counts[i]);
  return { mae: sum / (width * height), maxPixel: maximum, maxTileMae, changedFraction: changed / (width * height), alphaChanged };
}

// Cache-sized fingerprints only classify candidates. Before moving any original,
// verify every decoded frame and every native-resolution RGB/alpha pixel locally.
// No frame samples, media uploads, giant cached native frames, or remote services.
export async function verifyMediaPair(leftPath, rightPath, { kind, signal } = {}) {
  return withSlot(signal, async () => {
    const answer = (decision, reason, metrics = {}) => ({ decision, reason, metrics });
    const streams = [];
    try {
      for (const filePath of [leftPath, rightPath]) if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0") || !EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw failure("invalid-media-path", "仅完整比对已归档的本地媒体文件。");
      const before = await Promise.all([lstat(leftPath), lstat(rightPath)]);
      if (before.some((s) => !s.isFile() || s.isSymbolicLink() || s.size <= 0)) return answer("review", "invalid-local-media");
      const tools = await similarityTools(), metadata = await Promise.all([probe(leftPath, tools, signal), probe(rightPath, tools, signal)]), [a, b] = metadata;
      kind ||= [...STILL_EXTENSIONS, ".png", ".gif", ".webp"].includes(path.extname(leftPath).toLowerCase()) ? "image" : "video";
      if (!["image", "video"].includes(kind)) return answer("review", "unknown-media-kind");
      const animated = (m, p) => [".gif"].includes(path.extname(p).toLowerCase()) || m.codec === "apng" || m.declaredFrames > 1 || m.duration > 0;
      if (kind === "image" && (animated(a, leftPath) || animated(b, rightPath))) return answer("review", "animated-image-review");
      if (Math.abs(a.aspect / b.aspect - 1) > .003) return answer("review", "native-aspect-differs");
      const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
      if (!Number.isSafeInteger(width * height) || width * height > 4_200_000 || width < 16 || height < 16) return answer("review", "native-verification-size-limit");
      if (kind === "video" && (a.duration <= 0 || b.duration <= 0 || a.duration > 90 || b.duration > 90 || a.fps <= 0 || b.fps <= 0 || a.fps > 65 || b.fps > 65
        || Math.abs(a.duration - b.duration) > Math.max(.04, 1 / Math.max(a.fps, b.fps)) || Math.abs(a.fps / b.fps - 1) > .002)) return answer("review", "native-video-timing-differs");
      if (a.audios.length !== b.audios.length || a.audios.length > 1 || a.audios.some((s, i) => s.channels !== b.audios[i].channels || s.sampleRate !== b.audios[i].sampleRate || s.channels > 2)) return answer("review", "native-audio-structure-differs");
      if (a.audios.length) {
        const audioHashes = await Promise.all([nativeAudioHash(leftPath, tools, signal), nativeAudioHash(rightPath, tools, signal)]);
        if (audioHashes[0] !== audioHashes[1]) return answer("review", "native-audio-needs-review");
      }
      const extras = kind === "image" ? ["-frames:v", "1"] : [];
      const filter = `scale=${width}:${height}:flags=area`;
      streams.push(frameStream(tools.ffmpeg, decodeArgs(leftPath, filter, "rgba", extras), width * height * 4, signal));
      streams.push(frameStream(tools.ffmpeg, decodeArgs(rightPath, filter, "rgba", extras), width * height * 4, signal));
      let frames = 0, maxMae = 0, maxPixel = 0, maxTileMae = 0, maxChangedFraction = 0, motionLeft = 0, motionRight = 0, previousLeft = null, previousRight = null;
      while (true) {
        aborted(signal);
        const [left, right] = await Promise.all(streams.map((s) => s.frames.next()));
        if (left.done || right.done) {
          if (left.done !== right.done) return answer("review", "native-frame-count-differs", { frames, width, height });
          break;
        }
        frames++;
        if (kind === "video") {
          const summarize = (rgba) => {
            const summary = Buffer.alloc(64 * 64);
            for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
              const i = (Math.min(height - 1, Math.floor((y + .5) * height / 64)) * width + Math.min(width - 1, Math.floor((x + .5) * width / 64))) * 4;
              summary[y * 64 + x] = Math.round(.2126 * rgba[i] + .7152 * rgba[i + 1] + .0722 * rgba[i + 2]);
            }
            return summary;
          };
          const currentLeft = summarize(left.value), currentRight = summarize(right.value);
          if (previousLeft) { motionLeft += colorDifference(previousLeft, currentLeft); motionRight += colorDifference(previousRight, currentRight); }
          previousLeft = currentLeft; previousRight = currentRight;
        }
        const metrics = nativeFrameDifference(left.value, right.value, width, height);
        maxMae = Math.max(maxMae, metrics.mae); maxPixel = Math.max(maxPixel, metrics.maxPixel); maxTileMae = Math.max(maxTileMae, metrics.maxTileMae); maxChangedFraction = Math.max(maxChangedFraction, metrics.changedFraction);
        if (metrics.alphaChanged || metrics.mae > 5 || metrics.maxPixel > 96 || metrics.maxTileMae > (kind === "image" ? 14 : 11) || metrics.changedFraction > .02) return answer("review", "native-local-detail-differs", { frames, width, height, maxMae, maxPixel, maxTileMae, maxChangedFraction, alphaChanged: metrics.alphaChanged });
        if (frames > 6000) return answer("review", "native-verification-frame-limit", { frames, width, height });
      }
      if (!frames || (kind === "image" && frames !== 1) || (kind === "video" && frames < 3)
        || metadata.some((m) => m.declaredFrames && m.declaredFrames !== frames)) return answer("review", "native-incomplete-decode", { frames, width, height });
      if (kind === "video" && Math.min(motionLeft, motionRight) / (frames - 1) < .35) return answer("review", "static-video-needs-review", { frames, width, height });
      const after = await Promise.all([lstat(leftPath), lstat(rightPath)]);
      if (after.some((s, i) => s.size !== before[i].size || s.mtimeMs !== before[i].mtimeMs || s.ctimeMs !== before[i].ctimeMs)) return answer("review", "media-changed-during-native-verification");
      return answer("merge", "all-native-frames-and-local-details-verified", { frames, width, height, maxMae, maxPixel, maxTileMae, maxChangedFraction });
    } catch (error) {
      aborted(signal);
      return answer("review", error.code || "native-verification-failed");
    } finally {
      for (const stream of streams) stream.stop();
      await Promise.allSettled(streams.map((s) => s.done));
    }
  });
}
