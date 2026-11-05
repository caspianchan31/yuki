// v1.2: the member avatar: a colored shape with two white eyes, an optional gold star
// for the manager and a state dot at the bottom-right. Nothing is wired to it yet; later tasks use
// it in the member surfaces.

import "./member-face.css";
import type { FaceShape } from "./member-face.ts";

function Eyes({
  x1,
  x2,
  y,
  rx,
  ry,
}: {
  x1: number;
  x2: number;
  y: number;
  rx: number;
  ry: number;
}) {
  return (
    <>
      <ellipse cx={x1} cy={y} rx={rx} ry={ry} fill="#fff" />
      <ellipse cx={x2} cy={y} rx={rx} ry={ry} fill="#fff" />
    </>
  );
}

function Shape({ shape, color }: { shape: FaceShape; color: string }) {
  switch (shape) {
    case "circle":
      return (
        <>
          <circle cx="20" cy="20" r="18" fill={color} />
          <Eyes x1={16} x2={24} y={19} rx={2.2} ry={3.4} />
        </>
      );
    case "square":
      return (
        <>
          <rect x="3" y="3" width="34" height="34" rx="9" fill={color} />
          <Eyes x1={16} x2={24} y={19} rx={2.2} ry={3.4} />
        </>
      );
    case "pill":
      return (
        <>
          <rect x="2" y="10" width="36" height="20" rx="10" fill={color} />
          <Eyes x1={16} x2={24} y={20} rx={1.9} ry={2.8} />
        </>
      );
    case "hexagon":
      return (
        <>
          <polygon points="20,2 36,11 36,29 20,38 4,29 4,11" fill={color} />
          <Eyes x1={16} x2={24} y={20} rx={2.2} ry={3.4} />
        </>
      );
    case "cloud":
      return (
        <>
          <g fill={color}>
            <circle cx="13" cy="23" r="9" />
            <circle cx="22" cy="17" r="11" />
            <circle cx="29" cy="24" r="8" />
            <rect x="13" y="22" width="16" height="10" />
          </g>
          <Eyes x1={18} x2={25} y={22} rx={1.9} ry={2.9} />
        </>
      );
    case "flake":
      return (
        <>
          <path
            d="M20 2 C22 13 27 18 38 20 C27 22 22 27 20 38 C18 27 13 22 2 20 C13 18 18 13 20 2 Z"
            fill={color}
          />
          <Eyes x1={17} x2={23} y={20} rx={1.8} ry={2.8} />
        </>
      );
  }
}

export function MemberFace({
  shape,
  color,
  size = 32,
  star,
  state,
  label,
}: {
  shape: FaceShape;
  color: string;
  size?: number;
  /** The manager's gold star at the top-right. */
  star?: boolean;
  /** The state dot at the bottom-right, the states shell/faces.ts uses. */
  state?: "run" | "wait" | "need" | "block" | "idle";
  /** Accessible name; without one the face is decorative (aria-hidden). */
  label?: string;
}) {
  return (
    <span
      className="mface"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 40 40">
        <Shape shape={shape} color={color} />
      </svg>
      {star ? (
        <svg className="mface-star" viewBox="0 0 24 24">
          <path
            d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.2l7.1-.6z"
            fill="#FFB224"
            stroke="#fff"
            strokeWidth={1.5}
          />
        </svg>
      ) : null}
      {state ? <span className={`mface-st ${state}`} /> : null}
    </span>
  );
}
