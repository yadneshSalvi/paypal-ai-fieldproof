"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { PlanPoint, PlanSourceView, ProposedPlan, PublishedPlanView } from "@/lib/planning/contracts";
import { moveVertex, polygonLabel } from "@/lib/planning/geometry";
import { zoneColors } from "./ui";

export type CanvasPlan = (Pick<ProposedPlan, "outline" | "walls" | "openings" | "zones"> | Pick<PublishedPlanView, "outline" | "walls" | "openings" | "zones">) & { pageAspectRatio?: number };
export function svgPoint(event: { clientX: number; clientY: number }, svg: SVGSVGElement): PlanPoint {
  const screen = svg.getScreenCTM();
  if (!screen) return { x: 0, y: 0 };
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(screen.inverse()), view = svg.viewBox.baseVal;
  return { x: Math.max(0, Math.min(1, point.x / view.width)), y: Math.max(0, Math.min(1, point.y / view.height)) };
}
export function PlanCanvas({ plan, source, pageNumber = 1, selected = "outline", onSelect, onPolygon, onCheckpoint, editable = false, overlay, onPoint, className = "" }: {
  plan: CanvasPlan; source?: PlanSourceView; pageNumber?: number; selected?: string; onSelect?: (id: string) => void;
  onPolygon?: (id: string, points: PlanPoint[], checkpoint: boolean) => void; onCheckpoint?: () => void; editable?: boolean;
  overlay?: (width: number, height: number) => ReactNode; onPoint?: (point: PlanPoint) => void; className?: string;
}) {
  const svg = useRef<SVGSVGElement>(null), drag = useRef<{ id: string; index: number; pointerId: number } | null>(null);
  const [zoom, setZoom] = useState(1), [sourceOpacity, setSourceOpacity] = useState(0), gridId = useId();
  const [renderedWidth, setRenderedWidth] = useState(700);
  useEffect(() => { if (!svg.current) return; const observer = new ResizeObserver(entries => { const observed = entries[0]?.contentRect.width; if (observed && observed > 0) setRenderedWidth(observed); }); observer.observe(svg.current); return () => observer.disconnect(); }, []);
  const page = source?.pages.find(p => p.number === pageNumber), width = 1000, height = width * (page ? page.height / page.width : plan.pageAspectRatio ? 1 / plan.pageAspectRatio : 5 / 6);
  const points = (values: PlanPoint[]) => values.map(p => `${p.x * width},${p.y * height}`).join(" ");
  const active = selected === "outline" ? plan.outline : plan.zones.find(z => z.id === selected)?.polygon;
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svg.current || !editable) return;
    const polygon = drag.current.id === "outline" ? plan.outline : plan.zones.find(z => z.id === drag.current!.id)?.polygon;
    if (polygon) onPolygon?.(drag.current.id, moveVertex(polygon, drag.current.index, svgPoint(event, svg.current)), false);
  };
  const moveKey = (event: KeyboardEvent<SVGCircleElement>, index: number) => {
    if (!active || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); const step = event.shiftKey ? .02 : .002;
    onPolygon?.(selected, moveVertex(active, index, { x: active[index].x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: active[index].y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) }), true);
  };
  return <div className={`pl-canvas-shell ${className}`}>
    <div className="pl-canvas-tools"><span><i className="pl-live-dot"/> {editable ? "Drawing desk" : "Reviewed layout"}</span><div><button type="button" className="pl-icon-button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(Math.max(1, zoom - .25))}><Minus size={15}/></button><output aria-label="Zoom level">{Math.round(zoom * 100)}%</output><button type="button" className="pl-icon-button" aria-label="Zoom in" disabled={zoom >= 2.5} onClick={() => setZoom(Math.min(2.5, zoom + .25))}><Plus size={15}/></button><button type="button" className="pl-icon-button" aria-label="Fit whole plan" onClick={() => setZoom(1)}><Maximize2 size={15}/></button></div></div>
    <div className="pl-canvas-viewport" tabIndex={zoom > 1 ? 0 : undefined} aria-label={zoom > 1 ? "Zoomed plan, scroll to inspect" : undefined}>
      <svg ref={svg} className="pl-plan-svg" style={{ width: `${zoom * 100}%` }} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Room boundary and work package zones" onPointerMove={pointerMove} onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }} onPointerCancel={() => { drag.current = null; }} onClick={event => { if (onPoint && svg.current) onPoint(svgPoint(event, svg.current)); }}>
        <title>Source plan with normalized work package geometry</title><defs><pattern id={gridId} width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="#bcc9c7" strokeWidth=".6"/></pattern></defs>
        <rect width={width} height={height} fill="#f2f4ef"/><rect width={width} height={height} fill={`url(#${gridId})`}/>
        {page && sourceOpacity > 0 && <image href={page.previewUrl} x="0" y="0" width={width} height={height} opacity={sourceOpacity}/>} 
        <polygon points={points(plan.outline)} fill={sourceOpacity > .7 ? "transparent" : "#fffdf7"} fillOpacity=".55" stroke="#1e3a5f" strokeWidth={selected === "outline" ? 3 : 2} vectorEffect="non-scaling-stroke" onClick={event => { if (!onPoint) { event.stopPropagation(); onSelect?.("outline"); } }}/>
        {plan.zones.map((zone, index) => { const center = polygonLabel(zone.polygon), color = zoneColors[index % zoneColors.length], words = zone.label.split(" "), midpoint = Math.ceil(words.length / 2); const lines = zone.label.length > 20 ? [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")] : [zone.label];
          return <g key={zone.id} role={onSelect ? "button" : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={`${zone.label}${zone.id === selected ? ", selected" : ""}`} aria-pressed={onSelect ? zone.id === selected : undefined}
            onClick={event => { if (!onPoint) { event.stopPropagation(); onSelect?.(zone.id); } }} onKeyDown={event => { if (onSelect && ["Enter", " "].includes(event.key)) { event.preventDefault(); onSelect(zone.id); } }} className={onSelect ? "pl-zone" : undefined}>
            <polygon points={points(zone.polygon)} fill={color} fillOpacity={selected === zone.id ? .25 : .13} stroke={color} strokeWidth={selected === zone.id ? 3 : 1.3} vectorEffect="non-scaling-stroke"/>
            <text x={center.x * width} y={center.y * height - (lines.length > 1 ? 5 : 0)} textAnchor="middle" fill="#1e3a5f" fontSize="17" fontWeight="600" className="pl-zone-label">{lines.map((line, i) => <tspan key={i} x={center.x * width} dy={i ? 22 : 0}>{line}</tspan>)}</text>
            <text x={center.x * width} y={center.y * height - 27 - (lines.length > 1 ? 7 : 0)} textAnchor="middle" fill={color} fontSize="11" letterSpacing="2">{String(index + 1).padStart(2, "0")}</text>
          </g>;
        })}
        {plan.openings.map(opening => { const wall = plan.walls.find(w => w.id === opening.wallId), a = wall && plan.outline[wall.edgeIndex], b = wall && plan.outline[wall.edgeIndex + 1]; if (!a || !b) return null;
          const start = { x: a.x + (b.x - a.x) * opening.start, y: a.y + (b.y - a.y) * opening.start }, end = { x: a.x + (b.x - a.x) * opening.end, y: a.y + (b.y - a.y) * opening.end };
          return <g key={opening.id}><title>{opening.kind} on {opening.wallId}</title><line x1={start.x * width} y1={start.y * height} x2={end.x * width} y2={end.y * height} stroke="#fffdf7" strokeWidth="9" vectorEffect="non-scaling-stroke"/><line x1={start.x * width} y1={start.y * height} x2={end.x * width} y2={end.y * height} stroke={opening.kind === "door" ? "#b58a30" : "#4a6fa5"} strokeWidth="3" strokeDasharray={opening.kind === "door" ? "7 4" : undefined} vectorEffect="non-scaling-stroke"/></g>;
        })}
        {overlay?.(width, height)}
        {editable && active?.slice(0, -1).map((point, index) => <g key={`${selected}-${index}`}><circle cx={point.x * width} cy={point.y * height} r={7 * width / renderedWidth} fill="#fffdf7" stroke="#1e3a5f" strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none"/><circle cx={point.x * width} cy={point.y * height} r={22 * width / renderedWidth} fill="transparent" stroke="transparent" strokeWidth="2" vectorEffect="non-scaling-stroke" tabIndex={0} role="button" aria-label={`${selected === "outline" ? "Room" : "Zone"} corner ${index + 1}; x ${point.x.toFixed(3)}, y ${point.y.toFixed(3)}. Arrow keys move; Shift moves farther.`}
          className="pl-corner" onKeyDown={event => moveKey(event, index)} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); onCheckpoint?.(); drag.current = { id: selected, index, pointerId: event.pointerId }; svg.current?.setPointerCapture(event.pointerId); }}/></g>) }
      </svg>
    </div>
    <div className="pl-canvas-caption"><span>{editable ? "Drag a corner · Arrow keys for fine adjustments" : "Plan geometry and review status stay separate from payments"}</span>{page && <label>Source <input type="range" min="0" max="1" step=".05" value={sourceOpacity} onChange={event => setSourceOpacity(Number(event.target.value))} aria-label="Original sketch opacity"/></label>}</div>
  </div>;
}
