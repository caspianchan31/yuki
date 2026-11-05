// v1.2: a member's face is a shape and a color the owner picks when the member is made. The
// server checks the same lists the web app draws from. The flake is the main member's alone, so
// it is not here.

export const memberFaceShapes = ["circle", "square", "pill", "hexagon", "cloud"] as const;
export type MemberFaceShape = (typeof memberFaceShapes)[number];

export const faceColors = [
  "#8B5E3C",
  "#E5484D",
  "#F76B15",
  "#FFB224",
  "#30A46C",
  "#12A594",
  "#3E63DD",
  "#8E4EC6",
  "#E93D82",
  "#8D8D8D",
] as const;
export type FaceColor = (typeof faceColors)[number];

export interface MemberFace {
  shape: MemberFaceShape;
  color: FaceColor;
}

/** The name a stored identity goes by. Spaces made before the rename still hold the old default. */
export function identityName(name: string | undefined): string {
  return !name || name === "OpenMuse" ? "Yuki" : name;
}

export function isMemberFaceShape(value: unknown): value is MemberFaceShape {
  return (memberFaceShapes as readonly unknown[]).includes(value);
}

export function isFaceColor(value: unknown): value is FaceColor {
  return (faceColors as readonly unknown[]).includes(value);
}

/** A stored face, or null for anything that is not exactly a listed shape and color. */
export function parseMemberFace(value: unknown): MemberFace | null {
  if (!value || typeof value !== "object") return null;
  const { shape, color } = value as { shape?: unknown; color?: unknown };
  return isMemberFaceShape(shape) && isFaceColor(color) ? { shape, color } : null;
}
