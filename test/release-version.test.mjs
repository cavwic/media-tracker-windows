import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseVersion, nextReleaseVersion, releaseNames } from "../packaging/release-version.mjs";

test("canonical release versions retain exact numeric meaning and have patch-zero internal versions", () => {
  for (const input of ["1.0", "1.0.0", "V1.0"]) {
    assert.deepEqual(parseReleaseVersion(input), { major: 1, minor: 0, semver: "1.0.0", label: "V1.0" });
    assert.equal(Object.isFrozen(parseReleaseVersion(input)), true);
  }
  assert.deepEqual(parseReleaseVersion("0.1"), { major: 0, minor: 1, semver: "0.1.0", label: "V0.1" });
  assert.equal(parseReleaseVersion("V9.10").semver, "9.10.0");
  assert.equal(parseReleaseVersion("123.456.0").label, "V123.456");
});

test("release versions reject nonzero patches, ambiguous formatting and filename injection", () => {
  for (const input of [undefined, null, 1, {}, [], "", "1", "v1.0", "V1.0.0", "1.0.1", "1.0.00", "01.0", "1.01",
    "V01.0", " 1.0", "1.0 ", "1 .0", "+1.0", "-1.0", "1.-1", "1.0-beta", "1.0.0+build", "1.0.0.0",
    "../1.0", "D:\\1.0", "1.0/old", "1.0\0", "1.0\n", "1.0\r", "1.0\t", "１.０"]) {
    assert.throws(() => parseReleaseVersion(input), TypeError);
  }
  assert.throws(() => parseReleaseVersion("9007199254740992.0"), RangeError);
  assert.throws(() => parseReleaseVersion("0.9007199254740992"), RangeError);
});

test("ordinary releases advance only the minor version and do not roll at minor nine", () => {
  assert.deepEqual(nextReleaseVersion("1.0.0"), { major: 1, minor: 1, semver: "1.1.0", label: "V1.1" });
  assert.equal(nextReleaseVersion("V9.9").label, "V9.10");
  assert.equal(nextReleaseVersion("1.5", { majorChange: false }).label, "V1.6");
  assert.equal(nextReleaseVersion(parseReleaseVersion("1.5")).label, "V1.6");
  assert.throws(() => nextReleaseVersion("1.9007199254740991"), RangeError);
});

test("only an explicit major-change boolean upgrades the major version and resets minor", () => {
  assert.deepEqual(nextReleaseVersion("1.5", { majorChange: true }), { major: 2, minor: 0, semver: "2.0.0", label: "V2.0" });
  for (const majorChange of [1, "true", null, {}, []]) assert.throws(() => nextReleaseVersion("1.5", { majorChange }), TypeError);
  assert.throws(() => nextReleaseVersion("9007199254740991.5", { majorChange: true }), RangeError);
});

test("release names distinguish standard, minimal and offline editions without dates", () => {
  assert.deepEqual(releaseNames("1.0.0"), { directoryName: "采集工具-标准版-V1.0", zipName: "采集工具-标准版-V1.0.zip" });
  assert.deepEqual(releaseNames("V1.0", { minimal: true }), { directoryName: "采集工具-最小版-V1.0", zipName: "采集工具-最小版-V1.0.zip" });
  assert.deepEqual(releaseNames("1.0", { includeRuntime: true }), { directoryName: "采集工具-离线版-V1.0", zipName: "采集工具-离线版-V1.0.zip" });
  assert.equal(releaseNames(nextReleaseVersion("1.0")).zipName, "采集工具-标准版-V1.1.zip");
  assert.throws(() => releaseNames("1.0", { minimal: true, includeRuntime: true }), TypeError);
  assert.throws(() => releaseNames("1.0", { minimal: 1 }), TypeError);
  assert.throws(() => releaseNames("1.0", { includeRuntime: "yes" }), TypeError);
});

test("parsed version records cannot smuggle mismatched labels or numeric fields into release paths", () => {
  const good = parseReleaseVersion("1.0");
  assert.equal(releaseNames(good).zipName, "采集工具-标准版-V1.0.zip");
  for (const invalid of [{ ...good, label: "../private" }, { ...good, major: 2 }, { ...good, minor: 1 },
    { ...good, semver: "1.0" }, { ...good, semver: "1.0.1" }, { ...good, semver: "../1.0" }, {}, [], null]) {
    assert.throws(() => releaseNames(invalid), TypeError);
    assert.throws(() => nextReleaseVersion(invalid), TypeError);
  }
});
