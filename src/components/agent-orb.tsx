"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

export type OrbState = "idle" | "inspecting" | "working" | "approval" | "paused" | "success" | "uncertain" | "error";

export interface FloatingPosition {
  x: number;
  y: number;
}

export const FLOATING_INSET = 16;

const DEFAULT_AVOID_SELECTOR = [
  "[data-agent-avoid]",
  ".agent-drawer",
  ".agent-orb",
  ".topbar",
  ".capability-strip",
  ".demo-banner",
  ".header-summaries",
  ".case-row",
  ".incident-row",
  ".case-detail-header",
  ".case-amount",
  ".evidence-item",
  ".card-actions",
  ".next-action",
  ".payment-link-box",
  ".agent-composer",
  "button:not(.agent-orb)",
  "a",
  "input",
  "textarea",
  "select",
  "summary"
].join(", ");

interface FloatingPositionOptions {
  bottomInset?: number;
  ignoreSelectors?: string[];
}

interface FloatingSize {
  width: number;
  height: number;
}

function collides(position: FloatingPosition, size: FloatingSize, rect: DOMRect, gap = 8) {
  return position.x < rect.right + gap
    && position.x + size.width > rect.left - gap
    && position.y < rect.bottom + gap
    && position.y + size.height > rect.top - gap;
}

function getAvoidRects(ignoreSelectors: string[]) {
  return [...document.querySelectorAll<HTMLElement>(DEFAULT_AVOID_SELECTOR)]
    .filter((element) => !ignoreSelectors.some((selector) => element.matches(selector) || element.closest(selector)))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * Keep floating agent UI inside the viewport and away from the financial
 * values and controls it should never obscure. Call this only in the browser.
 */
export function findSafeFloatingPosition(preferred: FloatingPosition, size: FloatingSize, options: FloatingPositionOptions = {}) {
  if (typeof window === "undefined") return preferred;

  const inset = FLOATING_INSET;
  const bottomInset = options.bottomInset ?? inset;
  const maxX = Math.max(inset, window.innerWidth - size.width - inset);
  const maxY = Math.max(inset, window.innerHeight - size.height - bottomInset);
  const clampPosition = (position: FloatingPosition) => ({
    x: Math.min(maxX, Math.max(inset, position.x)),
    y: Math.min(maxY, Math.max(inset, position.y))
  });
  const clampedPreferred = clampPosition(preferred);
  const rects = getAvoidRects(options.ignoreSelectors || []);
  const isSafe = (position: FloatingPosition) => !rects.some((rect) => collides(position, size, rect));
  if (isSafe(clampedPreferred)) return clampedPreferred;

  const midX = (inset + maxX) / 2;
  const midY = (inset + maxY) / 2;
  const candidates = [
    clampedPreferred,
    { x: inset, y: inset },
    { x: midX, y: inset },
    { x: maxX, y: inset },
    { x: inset, y: midY },
    { x: maxX, y: midY },
    { x: inset, y: maxY },
    { x: midX, y: maxY },
    { x: maxX, y: maxY }
  ].map(clampPosition);
  const safeCandidate = candidates
    .filter(isSafe)
    .sort((left, right) => Math.hypot(left.x - clampedPreferred.x, left.y - clampedPreferred.y) - Math.hypot(right.x - clampedPreferred.x, right.y - clampedPreferred.y))[0];

  return safeCandidate || clampedPreferred;
}

interface OrbProps {
  state: OrbState;
  label: string;
  onClick: () => void;
  open: boolean;
}

interface OrbDragSession {
  pointerId: number;
  startX: number;
  startY: number;
  startPosition: FloatingPosition;
  moved: boolean;
}

const orbSize = (open: boolean) => open ? 52 : 44;

export function AgentOrb({ state, label, onClick, open }: OrbProps) {
  const [position, setPosition] = useState<FloatingPosition>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<OrbDragSession | null>(null);
  const suppressClickRef = useRef(false);
  const positionedRef = useRef(false);

  useEffect(() => {
    const reposition = () => {
      const size = orbSize(open);
      setPosition((current) => {
        const preferred = positionedRef.current
          ? current
          : { x: window.innerWidth - size - FLOATING_INSET, y: window.innerHeight - size - FLOATING_INSET };
        positionedRef.current = true;
        return findSafeFloatingPosition(preferred, { width: size, height: size }, { ignoreSelectors: [".agent-orb", ".orb-hint"] });
      });
    };

    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const updatePosition = (next: FloatingPosition) => {
    const size = orbSize(open);
    positionedRef.current = true;
    setPosition(findSafeFloatingPosition(next, { width: size, height: size }, { ignoreSelectors: [".agent-orb", ".orb-hint"] }));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startPosition: position, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.hypot(deltaX, deltaY) > 4) drag.moved = true;
    updatePosition({ x: drag.startPosition.x + deltaX, y: drag.startPosition.y + deltaY });
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowUp" ? { x: 0, y: -step }
      : event.key === "ArrowDown" ? { x: 0, y: step }
        : event.key === "ArrowLeft" ? { x: -step, y: 0 }
          : event.key === "ArrowRight" ? { x: step, y: 0 }
            : null;
    if (!delta) return;
    event.preventDefault();
    updatePosition({ x: position.x + delta.x, y: position.y + delta.y });
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onClick();
  };

  const size = orbSize(open);
  const hintWidth = 188;
  const hintX = typeof window === "undefined" ? FLOATING_INSET : Math.min(position.x, Math.max(FLOATING_INSET, window.innerWidth - hintWidth - FLOATING_INSET));
  const hintBelow = position.y < 64;
  const hintY = hintBelow ? position.y + size + 10 : position.y - 38;
  const style = { "--orb-x": `${position.x}px`, "--orb-y": `${position.y}px` } as CSSProperties;
  const hintStyle = { "--hint-x": `${hintX}px`, "--hint-y": `${Math.max(FLOATING_INSET, hintY)}px` } as CSSProperties;

  return <>
    <button
      id="agent-orb-trigger"
      type="button"
      className={`agent-orb ${state} ${open ? "active" : ""} ${dragging ? "dragging" : ""}`}
      style={style}
      aria-label={`${label}. ${open ? "Close" : "Open"} Rebound agent activity. Use arrow keys to move.`}
      aria-expanded={open}
      aria-controls="agent-drawer"
      aria-grabbed={dragging}
      aria-describedby="agent-orb-hint"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
    >
      <span className="orb-eyes" aria-hidden="true"><span className="eye" /><span className="eye" /></span>
      <span className="orb-status" aria-live="polite">{label}</span>
    </button>
    <span id="agent-orb-hint" className="orb-hint" style={hintStyle}>Drag to move · Arrow keys nudge · Enter opens activity</span>
  </>;
}
