// v1.2: a member's face is stable and varied: the same seed always gives the same
// shape and color, the manager's flake is never picked, and across a run of seeds every other
// shape and every color turns up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { faceColors, faceOf, faceShapes, pickFace } from "../apps/web/src/ui/member-face.ts";
import { memberFaceShapes, parseMemberFace } from "../packages/domain/src/member-face.ts";

const seeds = Array.from({ length: 200 }, (_, i) => `member-${i}`);

test("the same seed gives the same face", () => {
  assert.deepEqual(pickFace("member-7"), pickFace("member-7"));
});

test("two different seeds are allowed to differ", () => {
  // v1.2: not required to differ; whichever way it lands, each is a face from the
  // exported lists.
  for (const seed of ["member-1", "member-2"]) {
    const face = pickFace(seed);
    assert.ok(faceShapes.includes(face.shape));
    assert.ok(faceColors.includes(face.color));
  }
});

test("the shape is never flake", () => {
  for (const seed of seeds) {
    assert.notEqual(pickFace(seed).shape, "flake");
  }
});

test("over 200 seeds every member shape and every color appears", () => {
  const shapes = new Set(seeds.map((seed) => pickFace(seed).shape));
  const colors = new Set(seeds.map((seed) => pickFace(seed).color));
  for (const shape of faceShapes) {
    if (shape === "flake") continue;
    assert.ok(shapes.has(shape), `shape ${shape} never appeared`);
  }
  for (const color of faceColors) {
    assert.ok(colors.has(color), `color ${color} never appeared`);
  }
});

test("the shape and color are members of the exported lists", () => {
  for (const seed of seeds) {
    const face = pickFace(seed);
    assert.ok(faceShapes.includes(face.shape), `shape ${face.shape} is not exported`);
    assert.ok(faceColors.includes(face.color), `color ${face.color} is not exported`);
  }
});

test("a saved face is what a member wears", () => {
  assert.deepEqual(faceOf({ name: "Ann", face: { shape: "hexagon", color: "#3E63DD" } }), {
    shape: "hexagon",
    color: "#3E63DD",
  });
});

test("a member with no saved face wears the one her name picks", () => {
  assert.deepEqual(faceOf({ name: "Ann" }), pickFace("Ann"));
  assert.deepEqual(faceOf({ name: "Ann", face: undefined }), pickFace("Ann"));
});

test("a saved face that is not a listed shape and color falls back to the name's", () => {
  for (const face of [
    { shape: "flake", color: "#3E63DD" },
    { shape: "circle", color: "#123456" },
    { shape: "circle" },
    { color: "#3E63DD" },
    "circle",
    null,
    42,
  ])
    assert.deepEqual(faceOf({ name: "Ann", face }), pickFace("Ann"), JSON.stringify(face));
});

test("the shapes a member may choose leave out the flake, and parse accepts only exact pairs", () => {
  assert.ok(!(memberFaceShapes as readonly string[]).includes("flake"));
  assert.deepEqual(memberFaceShapes, ["circle", "square", "pill", "hexagon", "cloud"]);
  for (const shape of memberFaceShapes)
    for (const color of faceColors)
      assert.deepEqual(parseMemberFace({ shape, color }), { shape, color });
  assert.equal(parseMemberFace({ shape: "flake", color: faceColors[0] }), null);
  assert.equal(parseMemberFace(undefined), null);
});
