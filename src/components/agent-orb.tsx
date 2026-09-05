"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

export type OrbState = "idle" | "inspecting" | "working" | "approval" | "paused" | "success" | "uncertain" | "error";

interface OrbProps {
  state: OrbState;
  label: string;
  targetId?: string;
  onClick: () => void;
  open: boolean;
}

export function AgentOrb({ state, label, targetId, onClick, open }: OrbProps) {
  const [position, setPosition] = useState({ x: typeof window === "undefined" ? 0 : window.innerWidth - 66, y: 16 });

  useEffect(() => {
    const place = () => {
      if (window.innerWidth < 820) {
        setPosition({ x: Math.max(120, Math.min(window.innerWidth - 70, Math.round(window.innerWidth / 2))), y: 122 });
        return;
      }
      const anchor = targetId ? document.getElementById(`case-anchor-${targetId}`) || document.getElementById(`incident-anchor-${targetId}`) : null;
      if (!anchor) { setPosition({ x: window.innerWidth - 66, y: 16 }); return; }
      const rect = anchor.getBoundingClientRect();
      // Keep the overlay attached to the selected row without crossing into the
      // detail panel or hiding the row's values. The quiet indicator remains the
      // per-row signal; the orb gets the clear space just above the foreground row.
      setPosition({ x: Math.max(12, rect.right - 44), y: Math.max(12, rect.top - 48) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(document.body);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [targetId]);

  const style = { "--orb-x": `${position.x}px`, "--orb-y": `${position.y}px` } as CSSProperties;
  return <>
    <button type="button" className={`agent-orb ${state} ${open ? "active" : ""}`} style={style} aria-label={`${label}. ${open ? "Close" : "Open"} Rebound agent activity`} aria-pressed={open} onClick={onClick}>
      <span className="orb-eyes" aria-hidden="true"><span className="eye" /><span className="eye" /></span>
      <span className="orb-status" role="status" aria-live="polite">{label}</span>
    </button>
    <span className="orb-hint" aria-hidden="true">{label}</span>
  </>;
}
