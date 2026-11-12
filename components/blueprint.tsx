"use client";
import { useId } from "react";
import type { PackageView } from "@/lib/contracts";

/** `reveal` plays the single sketch-to-blueprint redraw: "sketch" shows the rough drawing, "redraw" strokes the
 * reviewed plan over it in 1.4 s, "drawn" is the finished plan. Without it the plan is simply shown. Reduced
 * motion goes straight to the final state (the global rule collapses the animation). */
export type BlueprintReveal="sketch"|"redraw"|"drawn";
const planPoint=(p:{x:number;y:number}):[number,number]=>[80+p.x*600,62+p.y*420];
const ROOM:[number,number][]=[[110,95],[650,95],[650,457],[110,457]];
/** Deterministic hand-drawn wobble: the same input always yields the same path on server and client. */
function roughPath(points:[number,number][],seed:number,wobble=6):string{
  let state=seed*2654435761%4294967296;
  const next=()=>{state=(state*1664525+1013904223)%4294967296;return state/4294967296-.5;};
  let d="";
  for(let i=0;i<points.length;i++){
    const [x1,y1]=points[i],[x2,y2]=points[(i+1)%points.length],dx=x2-x1,dy=y2-y1,over=.035;
    const sx=x1-dx*over+next()*wobble,sy=y1-dy*over+next()*wobble,ex=x2+dx*over+next()*wobble,ey=y2+dy*over+next()*wobble;
    d+=`M${sx.toFixed(1)} ${sy.toFixed(1)}Q${((sx+ex)/2+next()*wobble*1.6).toFixed(1)} ${((sy+ey)/2+next()*wobble*1.6).toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  }
  return d;
}
function SketchLayer({packages,highlight}:{packages:PackageView[];highlight?:string}){
  return <g className="plan-sketch" aria-hidden="true">
    <path d={roughPath(ROOM,7,7)+roughPath(ROOM,19,5)} fill="none" stroke="#56636f" strokeWidth="2.1" strokeLinecap="round"/>
    {packages.map((item,index)=>{const points=item.zone.points.map(planPoint),[lx,ly]=planPoint(item.zone.label);
      return <g key={item.id}>
        {highlight===item.id&&<polygon points={points.map(p=>p.join(",")).join(" ")} fill="#f2a93b" fillOpacity=".3" stroke="#a87721" strokeWidth="2.4" strokeDasharray="7 5"/>}
        <path d={roughPath(points,31+index*13)+roughPath(points,57+index*11,4)} fill="none" stroke="#6b7884" strokeWidth="1.5" strokeLinecap="round"/>
        <text x={lx} y={ly+6} textAnchor="middle" className="sketch-label" transform={`rotate(${index%2?-2.5:2} ${lx} ${ly})`}>{item.shortTitle.toLowerCase()}</text>
        {item.id==="electronics"&&<text x={lx} y={ly+27} textAnchor="middle" className="sketch-note" transform={`rotate(2 ${lx} ${ly})`}>6 benches?</text>}
        {item.id==="safety"&&<text x={lx} y={ly+27} textAnchor="middle" className="sketch-note" transform={`rotate(-2 ${lx} ${ly})`}>air first!</text>}
      </g>;})}
    <path d="M452 462q30-64 58-2" fill="none" stroke="#6b7884" strokeWidth="1.4" strokeLinecap="round"/><text x="478" y="485" textAnchor="middle" className="sketch-note">door</text>
  </g>;
}
/** A small view of the rough sketch with one zone outlined: the source region behind a reviewed zone. */
export function SketchRegion({packages,highlight,label}:{packages:PackageView[];highlight:string;label:string}){
  return <svg className="sketch-region" viewBox="60 60 640 430" role="img" aria-label={label}><rect x="60" y="60" width="640" height="430" fill="#fbf8ee"/><g className="plan-sketch shown"><SketchLayer packages={packages} highlight={highlight}/></g></svg>;
}
export function Blueprint({packages,selected,onSelect,large=false,reveal}:{packages:PackageView[];selected:string;onSelect:(id:string)=>void;large?:boolean;reveal?:BlueprintReveal}){
  const uid=useId().replaceAll(":","");
  const coords=(points:{x:number;y:number}[])=>points.map(p=>`${80+p.x*600},${62+p.y*420}`).join(" ");
  const drawing=reveal==="sketch"||reveal==="redraw",hidden=reveal==="sketch";
  return <div className={`blueprint ${large?"blueprint-large":""} ${reveal?`blueprint-reveal-${reveal}`:""}`}>
    <div className="drawing-label"><span>THE EASTSIDE MAKERSPACE</span><span>PLAN 01 / REV. 01</span></div>
    <svg viewBox="0 0 760 575" role="img" aria-label={hidden?"A rough hand-drawn sketch of the room, before it is redrawn as a plan.":"Interactive sample floor plan. Select a package to see its budget and evidence."}>
      <defs>
        <pattern id={`${uid}-grid`} width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" stroke="#1e3a5f" strokeWidth=".45" opacity=".14"/></pattern>
        <pattern id={`${uid}-hatch`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#ad7b31" strokeWidth="2" opacity=".28"/></pattern>
        <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#6a7a8b"/></marker>
      </defs>
      <rect width="760" height="575" fill={`url(#${uid}-grid)`}/>
      {reveal&&<SketchLayer packages={packages}/>}
      <g className="plan-crisp" aria-hidden={hidden||undefined}>
      <g className="dimension-lines plan-detail" stroke="#6a7a8b" fill="none" strokeWidth=".9">
        <path d="M110 58V31M650 58V31M110 42H650" markerStart={`url(#${uid}-arrow)`} markerEnd={`url(#${uid}-arrow)`}/>
        <path d="M68 95H42M68 457H42M54 95V457" markerStart={`url(#${uid}-arrow)`} markerEnd={`url(#${uid}-arrow)`}/>
      </g>
      <g className="plan-detail" fill="#6a7a8b" fontFamily="IBM Plex Mono, monospace" fontSize="9" letterSpacing="1.5"><rect x="328" y="31" width="104" height="20" fill="#f4f1ea"/><text x="380" y="44" textAnchor="middle">ROOM OUTLINE</text><text transform="translate(42 280) rotate(-90)" textAnchor="middle">ILLUSTRATIVE · NOT TO SCALE</text></g>
      <path className="room-outline plan-stroke" pathLength={drawing?1:undefined} d="M110 95H650V457H510M443 457H110V95" stroke="#1e3a5f" strokeWidth="5" fill="none"/>
      <g className="plan-detail"><path d="M443 457V390M443 390A67 67 0 0 1 510 457" stroke="#1e3a5f" strokeWidth="1.4" fill="none"/>
      <g stroke="#f4f1ea" strokeWidth="8"><path d="M166 95H242M318 95H390M479 95H557"/></g>
      <g stroke="#4a6fa5" strokeWidth="1.5"><path d="M166 92H242M166 98H242M318 92H390M318 98H390M479 92H557M479 98H557"/></g></g>
      {packages.map((item,index)=>{
        const active=item.id===selected;
        const fill=item.id==="electronics"?"#edc775":item.id==="printing"?"#d7e2d7":item.id==="safety"?"#e4e9e8":"#ece9e2";
        return <g key={item.id} role="button" aria-label={`${item.title}, ${item.budgetMinor/100} dollar budget. ${active?"Selected.":""}`} aria-pressed={active} onClick={()=>onSelect(item.id)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect(item.id);}}} className={`plan-zone ${active?"selected":""}`} tabIndex={hidden?-1:0}>
          <polygon className="plan-stroke plan-fill" pathLength={drawing?1:undefined} style={reveal?{animationDelay:`${180+index*110}ms`}:undefined} points={coords(item.zone.points)} fill={fill} fillOpacity={active?1:.6} stroke={active?"#a87721":"#8393a3"} strokeWidth={active?2.2:1} strokeDasharray={item.id==="laser"&&!drawing?"4 4":undefined}/>
          <g className="plan-detail">{item.id==="electronics"&&<polygon points={coords(item.zone.points)} fill={`url(#${uid}-hatch)`} pointerEvents="none"/>}
          <Furniture kind={item.id}/>
          <text x={80+item.zone.label.x*600} y={62+item.zone.label.y*420+18} textAnchor="middle" className="zone-label">{item.shortTitle}</text>
          {item.id!=="materials"&&<text x={80+item.zone.label.x*600} y={62+item.zone.label.y*420+35} textAnchor="middle" className="zone-amount">${(item.budgetMinor/100).toLocaleString("en-US")}</text>}</g>
        </g>;
      })}
      <g transform="translate(694 80)" stroke="#1e3a5f" fill="none"><path d="M0 35V0L-5 10M0 0L5 10" strokeWidth="1.4"/><text x="0" y="-9" textAnchor="middle" fill="#1e3a5f" stroke="none" fontSize="10">N</text></g>
      <g transform="translate(116 505)" fontFamily="IBM Plex Mono, monospace" fontSize="9" fill="#6a7a8b"><path d="M0 0H70M0-4V4M35-4V4M70-4V4" stroke="#6a7a8b"/><text x="0" y="20">A SHARED IDEA, DRAWN TOGETHER.</text></g>
      <text x="650" y="523" textAnchor="end" className="draft-note">Let's make room.</text>
      </g>
    </svg>
    <div className="plan-legend"><span><i className="legend-dot pledged"/>Pledged</span><span><i className="legend-dot collected"/>Collected</span><span><i className="legend-dot planned"/>Still an idea</span><span className="plan-hint">Select a space to explore ↗</span></div>
  </div>;
}
function Furniture({kind}:{kind:string}){
  const common={fill:"none",stroke:"#1e3a5f",strokeWidth:1.2,opacity:.72};
  if(kind==="electronics")return <g {...common}>{[0,1,2].map(i=><g key={i} transform={`translate(${413+i*64} 113)`}><rect width="49" height="31" rx="2"/><path d="M8 8H22V22H8zM28 20l8-13M30 10l8 7"/><rect x="16" y="38" width="19" height="14" rx="4"/></g>)}</g>;
  if(kind==="printing")return <g {...common}>{[0,1,2].map(i=><g key={i} transform={`translate(${140+i*65} 115)`}><rect width="43" height="40" rx="2"/><path d="M7 5H36V29H7zM7 10L36 29M7 29L36 10M11 35H31"/></g>)}</g>;
  if(kind==="woodworking")return <g {...common}><rect x="133" y="302" width="145" height="38" rx="2"/><path d="M142 309H269M142 333H269M154 302v38M255 302v38"/><circle cx="183" cy="319" r="5"/><path d="M202 312l18 15M220 312l-18 15"/></g>;
  if(kind==="safety")return <g {...common}><rect x="354" y="304" width="56" height="35" rx="2"/><circle cx="382" cy="321" r="11"/><path d="M382 310v22M371 321h22M416 315h23v58M439 373h-14"/></g>;
  if(kind==="laser")return <g {...common}><rect x="529" y="302" width="100" height="29" rx="2"/><path d="M537 307h83v19h-83zM580 307v19M537 317h83"/></g>;
  return <g {...common}><path d="M519 420h19v21h-19zM541 420h19v21h-19zM563 420h19v21h-19zM585 420h19v21h-19zM607 420h19v21h-19z"/></g>;
}
