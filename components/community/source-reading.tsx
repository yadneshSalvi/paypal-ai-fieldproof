"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, FileText, Globe2, Link2, LockKeyhole, RefreshCw } from "lucide-react";
import type { BriefSource, BriefSourceRow, BriefStatement, CommunityLocale, SupporterStory } from "@/lib/community/contracts";
import { renderStatement } from "@/lib/community/content";
import { bindWorkspaceContext, workspaceFetch, workspaceTabIdentity } from "@/lib/community/workspace-fetch";
import { CommunityEmpty, CommunityShell, communityDate, communityMoney } from "./shared";
import { ContributionStory, StoryDialog } from "./contribution-story";
import "@/app/supporter-story.css";

export function SourceSentence({statement,source,locale="en",translation}:{statement:BriefStatement;source:Pick<BriefSource,"rows"|"capturedAt"|"contentHash">;locale?:CommunityLocale;translation?:string}) {
  const [open,setOpen]=useState(false),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>setOpen(false),[source.contentHash]);
  return <div className="cm-source-sentence"><p>{renderStatement(statement,locale,translation)}</p><button ref={trigger} className="cm-cite" onClick={()=>setOpen(true)} aria-label={`${locale==="es"?"Ver fuentes de":"View sources for"} ${statement.id}`}><Link2 size={12}/>{locale==="es"?"Fuente":"Source"}<span>{statement.citations.length}</span></button>{open&&<CitationDialog statement={statement} source={source} locale={locale} opener={trigger.current} onClose={()=>setOpen(false)}/>}</div>;
}
function CitationDialog({statement,source,locale,opener,onClose}:{statement:BriefStatement;source:Pick<BriefSource,"rows"|"capturedAt"|"contentHash">;locale:CommunityLocale;opener:HTMLElement|null;onClose:()=>void}) {
  const rows=statement.citations.map(citation=>source.rows.find(row=>row.id===citation.rowId&&row.hash===citation.rowHash)).filter((row):row is BriefSourceRow=>!!row);
  return <StoryDialog title={locale==="es"?"Una frase que puedes seguir.":"A sentence you can follow."} locale={locale} opener={opener} onClose={onClose}><p className="cm-cited-quote">{renderStatement(statement,"en")}</p><p className="cm-caption">Captured {communityDate(source.capturedAt)}. This is a private source snapshot; later records may differ.</p>{rows.length===statement.citations.length?rows.map(row=><section className="cm-citation-row" key={row.id}><div><h3>{row.label}</h3><Link href={row.href}>Open source workspace<ArrowUpRight size={14}/></Link></div><dl>{Object.entries(row.fields).filter(([,value])=>!Array.isArray(value)).map(([key,value])=><div key={key}><dt>{key.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/Minor$/," (USD)")}</dt><dd>{value===null?"Not recorded":typeof value==="boolean"?value?"Yes":"No":typeof value==="number"&&key.endsWith("Minor")?communityMoney(value):String(value)}</dd></div>)}</dl>{Object.entries(row.fields).filter(([,value])=>Array.isArray(value)).map(([key,value])=><details key={key}><summary>{key.replace(/([a-z])([A-Z])/g,"$1 $2")} · {(value as string[]).length}</summary><ul>{(value as string[]).map((entry,index)=><li key={index}><code>{entry}</code></li>)}</ul></details>)}<div className="cm-hash"><span>Row identity / digest</span><code>{row.id}<br/>{row.hash}</code></div></section>):<p className="cm-notice error" role="alert">This sentence’s exact row is unavailable. Its citation must be repaired before use.</p>}<div className="cm-hash"><span>Source snapshot digest</span><code>{source.contentHash}</code></div><footer className="st-dialog-footer"><button className="button secondary" onClick={onClose}>{locale==="es"?"Volver a la historia":"Back to the story"}<Check size={15}/></button></footer></StoryDialog>;
}

/** Hide immediately on a different identity, and discard every late response. */
function useStory(initial:SupporterStory|undefined,projectId:string|null,scopeKey:string) {
  const scope=`${projectId??""}:${scopeKey}`;
  const [saved,setSaved]=useState<{story:SupporterStory;scope:string}|null>(initial?{story:initial,scope}:null);
  const [error,setError]=useState<string|null>(null),[covered,setCovered]=useState(false),[refreshing,setRefreshing]=useState(false),[changed,setChanged]=useState(false);
  const epoch=useRef(0),pending=useRef<AbortController|null>(null),context=useRef(initial?.journey.contextHash??null),current=useRef(initial??null),activeScope=useRef(scope);
  const cancel=useCallback(()=>{epoch.current++;pending.current?.abort();pending.current=null;},[]);
  const load=useCallback(async(cover=false)=>{
    if(!projectId)return;cancel();const requestEpoch=epoch.current,abort=new AbortController();pending.current=abort;
    if(cover)setCovered(true);setRefreshing(true);setError(null);
    try {
      const response=await workspaceFetch("/api/community/supporter",{signal:abort.signal,headers:context.current?{"X-Fieldproof-Story-Context":context.current}:{}});
      const value=await response.json() as {story?:SupporterStory;error?:string};
      if(!response.ok||!value.story)throw new Error(value.error??"This story could not be read. Try again.");
      if(requestEpoch!==epoch.current||abort.signal.aborted||activeScope.current!==scope)return;
      if(value.story.journey.projectId!==projectId||(context.current&&value.story.journey.contextHash!==context.current))throw new Error("The saved identity changed. Open the current workspace again.");
      setChanged(!!current.current&&current.current.journey.sourceHash!==value.story.journey.sourceHash);
      current.current=value.story;context.current=value.story.journey.contextHash;setSaved({story:value.story,scope});setCovered(false);
    } catch(cause) { if(requestEpoch!==epoch.current||abort.signal.aborted)return;setSaved(null);current.current=null;setError(cause instanceof Error?cause.message:"This story is unavailable. Try again.");setCovered(false); }
    finally {if(requestEpoch===epoch.current)setRefreshing(false);}
  },[cancel,projectId,scope]);
  useEffect(()=>{
    activeScope.current=scope;cancel();context.current=initial?.journey.contextHash??null;current.current=initial??null;
    setSaved(initial?{story:initial,scope}:null);setCovered(false);setError(null);setChanged(false);
    if(!initial)void load();return cancel;
  },[scope,initial,load,cancel]);
  useEffect(()=>{
    const onVisibility=()=>{if(document.visibilityState==="hidden"){cancel();setCovered(true);}else void load(true);};
    const onFocus=()=>{if(document.visibilityState==="visible")void load(true);};
    document.addEventListener("visibilitychange",onVisibility);window.addEventListener("focus",onFocus);
    const channel=typeof BroadcastChannel==="undefined"?null:new BroadcastChannel("fieldproof-workspace-changed");
    if(channel)channel.onmessage=event=>{if(event.data?.origin===workspaceTabIdentity())return;cancel();setSaved(null);current.current=null;setCovered(false);setError("The saved workspace changed in another tab. Open the current workspace to continue.");};
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void load();},30_000);
    return()=>{document.removeEventListener("visibilitychange",onVisibility);window.removeEventListener("focus",onFocus);channel?.close();clearInterval(timer);};
  },[cancel,load]);
  return {story:covered||saved?.scope!==scope?null:saved.story,error,refreshing,changed,refresh:()=>void load(true)};
}

export function SupporterStoryView({initial,projectId,standalone=true,scopeKey="current"}:{initial?:SupporterStory;projectId:string|null;standalone?:boolean;scopeKey?:string}) {
  bindWorkspaceContext(projectId);
  const {story,error,refreshing,changed,refresh}=useStory(initial,projectId,scopeKey),[locale,setLocale]=useState<CommunityLocale>("en");
  const resultHeading=useRef<HTMLHeadingElement>(null),refreshOrigin=useRef<Element|null|undefined>(undefined);
  const refreshForReader=()=>{refreshOrigin.current=document.activeElement;refresh();};
  useEffect(()=>{
    const moved=(event:FocusEvent)=>{if(refreshOrigin.current!==undefined&&event.target!==refreshOrigin.current&&event.target!==document.body)refreshOrigin.current=undefined;};
    document.addEventListener("focusin",moved);
    return()=>document.removeEventListener("focusin",moved);
  },[]);
  useEffect(()=>{refreshOrigin.current=undefined;},[projectId,scopeKey]);
  useEffect(()=>{
    if(refreshing||(!story&&!error)||refreshOrigin.current===undefined)return;
    const origin=refreshOrigin.current;refreshOrigin.current=undefined;
    const active=document.activeElement;
    if(document.visibilityState==="hidden"||document.querySelector("dialog[open]")||(active!==document.body&&active!==origin))return;
    resultHeading.current?.focus({preventScroll:true});
  },[refreshing,story,error]);
  const es=locale==="es";
  const content=!projectId?<CommunityEmpty title="Your contribution has a place."><p>Open a saved workspace to see your own contribution records and the source-backed project story.</p><Link className="button primary" href="/community">Open saved workspaces<ArrowUpRight size={16}/></Link></CommunityEmpty>:error?<CommunityEmpty title="This story needs current access." headingRef={resultHeading}><p role="alert">{error}</p><div className="cm-button-row"><button className="button primary" onClick={refreshForReader}><RefreshCw size={16}/>Try reading again</button><Link className="button secondary" href="/community">Open saved workspaces</Link></div></CommunityEmpty>:!story?<div className="st-loading" role="status"><span className="st-loading-line"/><p>Connecting your place in the story…</p><small>Checking the saved records and your current access.</small></div>:<section className="cm-supporter st-reading" lang={locale}>
    <div className="st-reading-heading"><div><p className="eyebrow">{story.source.title}</p><h1 ref={resultHeading} tabIndex={-1}>{es?"Tu lugar en la historia.":"Your place in the story."}</h1><p>{es?"Una idea compartida. Tu aportación, con sus fuentes.":"A shared idea. Your contribution, with its sources."}</p></div><div className="st-reading-controls"><div className="cm-language" role="group" aria-label={es?"Idioma de la historia":"Story language"}><Globe2 size={15}/><button lang="en" aria-pressed={!es} onClick={()=>setLocale("en")}>English</button><button lang="es" aria-pressed={es} onClick={()=>setLocale("es")}>Español</button></div><button className="st-refresh" disabled={refreshing} onClick={refreshForReader}><RefreshCw size={13}/>{es?"Actualizar fuentes":"Refresh sources"}</button></div></div>
    <div className="cm-story-cutoff"><span><LockKeyhole size={13}/>{es?"Vista privada del proyecto":"Private project view"}</span><span>{communityDate(story.source.capturedAt)}</span></div>
    {es&&<div className="cm-notice st-language-note"><Globe2 size={18}/><p>Texto español inicial, sin revisión de una persona que domine el idioma. Las cifras y fechas usan la misma fuente vinculada que el inglés. Los títulos y detalles originales de los registros se conservan en inglés; cada actualización indica su propia revisión.</p></div>}
    {changed&&<p className="st-changed" role="status">{es?"Las fuentes han cambiado. Esta vista ya muestra los registros vigentes.":"The sources changed. This view now shows the current records."}</p>}
    <ContributionStory story={story} locale={locale} onRefresh={refreshForReader}/>
    <details className="st-project-context"><summary><span><span className="eyebrow">{es?"EL CONTEXTO COMPARTIDO":"THE SHARED CONTEXT"}</span><strong>{es?"El resto de la historia del proyecto.":"The rest of the project’s story."}</strong></span><ArrowUpRight size={20}/></summary><div className="st-project-context-body"><div className="cm-personal-card"><span className="cm-kicker">{es?"TUS REGISTROS":"YOUR OWN RECORDS"}</span>{story.personal.statements.map(statement=><SourceSentence key={statement.id} statement={statement} source={story.personal} locale={locale}/>)}<p className="cm-caption">{es?"Esta sección solo incluye aportaciones de tu identidad actual en el proyecto.":"This section includes only contribution records owned by your current project identity."}</p><Link className="cm-text-link" href="/funding?view=support">{es?"Ver mi apoyo y mis decisiones":"Open my support & decisions"}<ArrowUpRight size={15}/></Link></div><div className="cm-story-layout"><div className="cm-story-main"><div className="cm-story-intro">{story.source.statements.filter(s=>s.category==="project").map(statement=><SourceSentence key={statement.id} statement={statement} source={story.source} locale={locale}/>)}</div><section><h2>{es?"El apoyo, con sus límites.":"Support, with clear boundaries."}</h2>{story.source.statements.filter(s=>s.category==="funding"&&!s.id.startsWith("package:")).map(statement=><SourceSentence key={statement.id} statement={statement} source={story.source} locale={locale}/>)}</section><section><h2>{es?"Lo que queda por revisar.":"What still needs a review."}</h2>{story.source.statements.filter(s=>["evidence","exception","consent"].includes(s.category)).map(statement=><SourceSentence key={statement.id} statement={statement} source={story.source} locale={locale}/>)}</section></div><aside className="cm-story-packages"><span className="eyebrow">{es?"PAQUETE POR PAQUETE":"PACKAGE BY PACKAGE"}</span>{story.source.statements.filter(s=>s.id.startsWith("package:")).map(statement=><SourceSentence key={statement.id} statement={statement} source={story.source} locale={locale}/>)}</aside></div></div></details>
    <section className="cm-update-previews st-update-previews"><div className="cm-section-heading"><div><p className="eyebrow">{es?"VISTA PREVIA · NO SE HA ENVIADO NINGÚN MENSAJE":"PREVIEW · NO MESSAGE HAS BEEN SENT"}</p><h2>{es?"Una actualización para compartir.":"An update to bring people along."}</h2></div><FileText size={28} strokeWidth={1.4}/></div>{story.journey.hiddenUpdateCount>0&&<p className="st-source-warning"><RefreshCw size={16}/>{es?"Las vistas previas de fuentes anteriores se han apartado. El organizador debe renovar la fuente y su revisión antes de compartirlas.":"Previews tied to earlier sources are set aside. The organizer needs a current source and review before sharing them."}</p>}{story.drafts.length?story.drafts.map(({draft,translation})=><article className="cm-saved-update" key={draft.id}><header><div><h3>{draft.title}</h3><span>{communityDate(draft.createdAt)}</span></div><span className={`cm-status ${translation?.status==="reviewed"?"good":""}`}>{translation?.status==="reviewed"?<><Check size={12}/>{es?"Revisión de español registrada":"Spanish fluency review recorded"}</>:translation?.status==="sample_review"?es?"Ejercicio de muestra, sin revisión de fluidez":"Sample exercise · no fluent review":es?"Solo versión inglesa":"English version only"}</span></header>{draft.paragraphs.map(statement=><SourceSentence key={statement.id} statement={statement} source={story.source} locale={es&&translation?"es":"en"} translation={es?translation?.paragraphs.find(p=>p.paragraphId===statement.id)?.text:undefined}/>)}{es&&!translation&&<p className="cm-caption">Esta vista previa conserva el inglés porque no hay una traducción revisada vigente.</p>}<details className="st-translation-source"><summary>{es?"Fuente y revisión de traducción":"Source & translation review"}</summary><p>{translation?.review?`${translation.review.reviewerLabel} · ${communityDate(translation.review.reviewedAt)} · ${translation.review.kind.replaceAll("_"," ")}`:es?"No se ha registrado una revisión de fluidez para esta vista previa.":"No fluent-language review is recorded for this preview."}</p><div className="cm-hash"><span>Exact update / source</span><code>{draft.contentHash}<br/>{draft.sourceHash}</code></div>{translation&&<div className="cm-hash"><span>Translation / exact English draft</span><code>{translation.contentHash}<br/>{translation.sourceHash}</code></div>}</details><p className="cm-caption">{es?"Solo vista previa dentro del proyecto. No se ha enviado ni programado una notificación.":"Project preview only. No notification has been sent or scheduled."}</p></article>):<div className="cm-saved-empty"><FileText size={23}/><p>{es?"Aún no hay una actualización vigente preparada por el organizador. Los registros del proyecto se muestran arriba.":"No current organizer update is ready for preview yet. The project records are shown above."}</p></div>}</section>
    <details className="st-source-binding"><summary>{es?"Fuente vinculada de esta historia":"This story’s bound source"}<Link2 size={13}/></summary><p>{es?"El inglés y el español usan estos mismos registros. No se ha registrado una revisión de fluidez de la narración de la interfaz.":"English and Spanish use these same records. No fluent-language review is recorded for the interface narration."}</p><div className="cm-hash"><span>Personal journey / shared source / own records</span><code>{story.journey.sourceHash}<br/>{story.source.contentHash}<br/>{story.personal.contentHash}</code></div></details>
  </section>;
  return standalone?<CommunityShell projectId={projectId} title={story?.source.title??"YOUR SUPPORTER STORY"} active="updates">{content}</CommunityShell>:content;
}
