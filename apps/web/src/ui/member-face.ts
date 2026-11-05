// v1.2: a member's face is a shape and a color. One she was made with is kept on her
// record; otherwise it is picked from a stable seed. The flake shape is kept for the main member
// (who also wears the gold star), so members get one of the other five.

import {
  type FaceColor,
  faceColors,
  parseMemberFace,
} from "../../../../packages/domain/src/member-face.ts";

export const faceShapes = ["flake", "circle", "square", "pill", "hexagon", "cloud"] as const;
export type FaceShape = (typeof faceShapes)[number];

export { type FaceColor, faceColors };

export interface Face {
  shape: FaceShape;
  color: FaceColor;
}

const memberShapes = faceShapes.filter(
  (shape): shape is Exclude<FaceShape, "flake"> => shape !== "flake",
);

/** A stable face for a member that chose none: the same seed always gives the same face. */
export function pickFace(seed: string): Face {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash >>>= 0;
  const shape = memberShapes[hash % memberShapes.length];
  const color = faceColors[(hash >>> 8) % faceColors.length];
  return { shape, color };
}

/** The face a member wears: the one saved on her record, else the one her name picks. */
export function faceOf(member: { name: string; face?: unknown }): Face {
  return parseMemberFace(member.face) ?? pickFace(member.name);
}
