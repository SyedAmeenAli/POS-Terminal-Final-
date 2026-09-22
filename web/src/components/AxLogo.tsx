import { useEffect, useRef } from "react";

type AxLogoProps = {
  /** Cube canvas size in CSS px. Wordmark scales with it. */
  size?: number;
  showWordmark?: boolean;
  /** Plays the authentication pulse (brief activation) instead of idle rest. */
  active?: boolean;
};

const isoRotX = Math.asin(1 / Math.sqrt(3));
const isoRotY = Math.PI / 4;

const baseNodes = [
  { x: -1, y: -1, z: -1 },
  { x: 1, y: -1, z: -1 },
  { x: 1, y: -1, z: 1 },
  { x: -1, y: -1, z: 1 },
  { x: -1, y: 1, z: -1 },
  { x: 1, y: 1, z: -1 },
  { x: 1, y: 1, z: 1 },
  { x: -1, y: 1, z: 1 },
] as const;

const faces = [
  { indices: [0, 1, 2, 3], light: 1.0 },
  { indices: [4, 5, 6, 7], light: 0.22 },
  { indices: [0, 4, 5, 1], light: 0.42 },
  { indices: [1, 5, 6, 2], light: 0.72 },
  { indices: [2, 6, 7, 3], light: 0.92 },
  { indices: [3, 7, 4, 0], light: 0.52 },
] as const;

function rotate3D(node: { x: number; y: number; z: number }, ax: number, ay: number) {
  let { x, y, z } = node;
  const cosX = Math.cos(ax);
  const sinX = Math.sin(ax);
  const y1 = y * cosX - z * sinX;
  const z1 = y * sinX + z * cosX;
  y = y1;
  z = z1;
  const cosY = Math.cos(ay);
  const sinY = Math.sin(ay);
  const x2 = x * cosY + z * sinY;
  const z2 = -x * sinY + z * cosY;
  return { x: x2, y, z: z2 };
}

/**
 * The isometric cube from the AxInventory brand asset, refined into a
 * reusable mark: idle rest, hover tumble, and a subtle authentication
 * pulse. Refuses to run the animation loop under prefers-reduced-motion -
 * it renders the resting isometric pose once and stops.
 */
export function AxLogo({ active = false, showWordmark = true, size = 32 }: AxLogoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = window.devicePixelRatio || 1;
    const logical = size;
    canvas.width = logical * dpr;
    canvas.height = logical * dpr;
    ctx.scale(dpr, dpr);
    const cubeSize = logical * 0.19;

    const state = { colorProgress: 0, fillOpacity: 0, lift: 0, rotX: isoRotX, rotY: isoRotY, time: 0 };
    const target = { colorProgress: 0, fillOpacity: 0, lift: 0, rotX: isoRotX, rotY: isoRotY };

    const applyHover = () => {
      target.rotX = isoRotX - 0.22;
      target.rotY = isoRotY + 0.3;
      target.lift = cubeSize * 0.5;
      target.colorProgress = 1;
      target.fillOpacity = 1;
    };
    const applyRest = () => {
      target.rotX = isoRotX;
      target.rotY = isoRotY;
      target.lift = 0;
      target.colorProgress = 0;
      target.fillOpacity = 0;
    };

    let raf = 0;
    const render = () => {
      ctx.clearRect(0, 0, logical, logical);

      state.rotX += (target.rotX - state.rotX) * 0.08;
      state.rotY += (target.rotY - state.rotY) * 0.08;
      state.lift += (target.lift - state.lift) * 0.12;
      state.colorProgress += (target.colorProgress - state.colorProgress) * 0.1;
      state.fillOpacity += (target.fillOpacity - state.fillOpacity) * 0.1;
      state.time += 0.02;

      const idleFloatY = target.lift === 0 && !reduceMotion ? Math.sin(state.time) * (logical * 0.015) : 0;

      const projected = baseNodes.map((node, index) => {
        const working = { ...node, x: node.x * cubeSize, y: node.y * cubeSize - (index < 4 ? state.lift : 0), z: node.z * cubeSize };
        const rotated = rotate3D(working, state.rotX, state.rotY);
        return { x: rotated.x + logical / 2, y: rotated.y + logical / 2 + idleFloatY, z: rotated.z };
      });

      const faceData = faces
        .map((face) => {
          const pts = face.indices.map((i) => projected[i]!);
          const zAvg = pts.reduce((sum, p) => sum + p.z, 0) / pts.length;
          return { light: face.light, pts, z: zAvg };
        })
        .sort((a, b) => a.z - b.z);

      for (const face of faceData) {
        ctx.beginPath();
        ctx.moveTo(face.pts[0]!.x, face.pts[0]!.y);
        for (const pt of face.pts.slice(1)) ctx.lineTo(pt.x, pt.y);
        ctx.closePath();

        if (state.fillOpacity > 0.01) {
          const l = face.light;
          ctx.fillStyle = `rgba(${Math.floor(159 * l)}, ${Math.floor(255 * l)}, ${Math.floor(192 * l)}, ${state.fillOpacity * 0.9})`;
          ctx.fill();
        }

        const idleColor = { b: 155, g: 168, r: 145 };
        const activeColor = { b: 192, g: 255, r: 159 };
        const r = idleColor.r + (activeColor.r - idleColor.r) * state.colorProgress;
        const g = idleColor.g + (activeColor.g - idleColor.g) * state.colorProgress;
        const b = idleColor.b + (activeColor.b - idleColor.b) * state.colorProgress;
        ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.lineWidth = Math.max(1.25, logical * 0.02);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
      }

      if (!reduceMotion) raf = requestAnimationFrame(render);
    };

    if (reduceMotion) {
      render();
    } else {
      raf = requestAnimationFrame(render);
    }

    const onEnter = () => {
      hoverRef.current = true;
      applyHover();
    };
    const onLeave = () => {
      hoverRef.current = false;
      applyRest();
    };
    canvas.parentElement?.addEventListener("mouseenter", onEnter);
    canvas.parentElement?.addEventListener("mouseleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      canvas.parentElement?.removeEventListener("mouseenter", onEnter);
      canvas.parentElement?.removeEventListener("mouseleave", onLeave);
    };
  }, [size]);

  return (
    <span className="ax-logo" data-active={active || undefined}>
      <canvas aria-hidden height={size} ref={canvasRef} style={{ height: size, width: size }} width={size} />
      {showWordmark ? (
        <span className="ax-wordmark">
          <strong>Ax</strong>Inventory
        </span>
      ) : null}
    </span>
  );
}
