"use client";
import Link from "next/link";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowUpRight, FolderOpen, HeartHandshake, LockKeyhole, X } from "lucide-react";
import type { FundingDesk } from "@/lib/funding/contracts";
import { workspaceFetch } from "@/lib/community/workspace-fetch";
import { WorkspaceScope } from "@/components/community/workspace-scope";

export const money=(minor:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:minor%100?2:0,maximumFractionDigits:2}).format(minor/100);
export const date=(iso:string)=>`${new Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(iso))} UTC`;
export function decimalMinor(value:string):number{if(!/^\d+(\.\d{1,2})?$/.test(value.trim()))return 0;const [dollars,cents=""]=value.trim().split("."),number=Number(BigInt(dollars)*100n+BigInt(cents.padEnd(2,"0")));return Number.isSafeInteger(number)?number:0;}
export const localDateInput=(offsetHours:number)=>{const value=new Date(Date.now()+offsetHours*3_600_000);value.setMinutes(value.getMinutes()-value.getTimezoneOffset());return value.toISOString().slice(0,16);};
export interface FundingResponse {desk:FundingDesk;result:unknown}
export type FundingAction=(path:string,body:unknown,message:string)=>Promise<FundingResponse|null>;
export class FundingRequestError extends Error{constructor(message:string,public code:string){super(message);}}
export async function fundingRequest<T>(path="",body?:unknown):Promise<T>{
  const response=await workspaceFetch(`/api/funding${path?`/${path}`:""}`,body===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new FundingRequestError(value.error??"This step could not finish. Check your saved support before continuing.",value.code??"REQUEST_UNAVAILABLE");return value;
}
const statusLabels:Record<string,string>={open:"Open for support",allocation_open:"Open for support",pledged:"Pledge saved",funded:"Target collected",collected:"Paid",partially_collected:"Partly returned",returned:"Returned",withdrawn:"Withdrawn",expired:"Window ended",cancelled:"Purpose closed",closed:"Purpose closed",offered:"Ready to review",accepted:"Agreement accepted",held:"Needs review",review_required:"Needs review",choice_open:"Donor choices open",partially_resolved:"Decisions in progress",resolved:"All shares resolved",superseded:"Earlier case",return_pending:"Return in progress",executed:"Choice applied",revoked:"Choice withdrawn",buyer_action:"Waiting for your PayPal approval",ready_capture:"Ready to complete",checkout:"Checking the original checkout",unknown:"Payment outcome being checked",refused:"PayPal did not accept this attempt",not_sent:"Payment was not sent",pending_reconciliation:"Checking the original return",recorded_without_match:"Recorded · no match earned",funding_review:"Funding needs review",recovering:"Collection in progress",collecting:"Collection in progress",ready:"Ready to collect",compensating:"Returns in progress"};
export function FundingStatus({state}:{state:string}){const positive=["funded","collected","returned","executed","resolved"].includes(state),review=["review_required","funding_review","held","refused","unknown","pending_reconciliation"].includes(state);return <span className={`fd-status ${positive?"positive":review?"review":""}`}><i aria-hidden="true"/>{statusLabels[state]??state.replaceAll("_"," ")}</span>;}
export function FundingShell({projectId,children}:{projectId:string|null;children:ReactNode}){return <div className="fd-shell"><WorkspaceScope projectId={projectId}/><a className="skip-link" href="#funding-main">Skip to funding desk</a><header className="fd-header"><Link className="wordmark" href="/" aria-label="Fieldproof home"><span className="brand-mark"><i/><i/><i/><i/></span>fieldproof<span className="brand-dot">.</span></Link><nav aria-label="Project workspace"><Link href="/">The project</Link><Link href="/funding" aria-current="page">Funding desk</Link><Link href="/planning">Planning desk</Link><Link href="/studio">Proof Studio</Link></nav><Link className="fd-library" href="/community?return=/funding"><FolderOpen size={17}/><span>Saved workspaces</span></Link></header><div className="fd-context"><span>PEOPLE · PURPOSE · PROOF</span><span><LockKeyhole size={12}/>{projectId?"Your private workspace":"Choose your workspace"} · USD</span></div><main id="funding-main" tabIndex={-1}>{children}</main><footer className="fd-footer"><span>A shared purpose.<br/><strong>A trail you can follow.</strong></span><div><Link href="/updates">Read the supporter story <ArrowUpRight size={14}/></Link><Link href="/privacy">Privacy & sources</Link><span>Sandbox demonstration · no physical work certified</span></div></footer></div>;}
export function FundingEmpty({title,children}:{title:string;children:ReactNode}){return <div className="fd-empty"><span className="fd-empty-mark"><HeartHandshake size={32} strokeWidth={1.3}/></span><h2>{title}</h2><div>{children}</div></div>;}
function canReceiveDialogFocus(target:HTMLElement|null):target is HTMLElement{
  return !!target?.isConnected&&target!==document.body&&!target.matches(":disabled,[aria-disabled='true']")&&!target.closest("[inert],[hidden],[aria-hidden='true'],dialog:not([open])")&&target.getClientRects().length>0&&getComputedStyle(target).visibility!=="hidden";
}
export function FundingModal({title,eyebrow,children,onClose,error,busy=false,wide=false,returnFocus,canReturnFocus}:{title:string;eyebrow?:string;children:ReactNode;onClose:()=>void;error?:string|null;busy?:boolean;wide?:boolean;returnFocus?:HTMLElement|null;canReturnFocus?:()=>boolean}){
  const dialog=useRef<HTMLDialogElement>(null),label=useId(),onCloseRef=useRef(onClose),returnAllowed=useRef(canReturnFocus),activation=useRef(0);onCloseRef.current=onClose;returnAllowed.current=canReturnFocus;
  useEffect(()=>{
    const previous=returnFocus??(document.activeElement instanceof HTMLElement?document.activeElement:null),node=dialog.current,generation=++activation.current;
    node?.showModal();node?.querySelector<HTMLElement>("[data-dialog-focus]")?.focus();
    return()=>{
      const active=document.activeElement,ownedFocus=active===document.body||active===node||!!node?.contains(active);
      node?.close();
      if(!ownedFocus)return;
      // React may remove the opener or re-enable it in the same commit. Wait
      // for that commit, but never take focus from a new view or another dialog.
      requestAnimationFrame(()=>{
        if(activation.current!==generation||returnAllowed.current?.()===false||document.visibilityState==="hidden"||document.querySelector("dialog[open]"))return;
        const current=document.activeElement;
        if(current instanceof HTMLElement&&!node?.contains(current)&&canReceiveDialogFocus(current))return;
        const targets=[previous,document.querySelector<HTMLElement>(".fd-viewbar nav button[aria-pressed='true']"),document.getElementById("funding-main")];
        targets.find(canReceiveDialogFocus)?.focus({preventScroll:true});
      });
    };
  },[]);
  useEffect(()=>{
    const node=dialog.current;
    if(node?.open&&!node.contains(document.activeElement))node.querySelector<HTMLElement>("[data-dialog-focus],button")?.focus();
  },[title]);
  return <dialog ref={dialog} className={`fd-modal ${wide?"wide":""}`} aria-labelledby={label} aria-busy={busy} onCancel={event=>{event.preventDefault();onCloseRef.current();}} onClick={event=>{if(event.target===dialog.current)onCloseRef.current();}}><div className="fd-modal-sheet"><header><div><p className="eyebrow">{eyebrow??"YOUR NEXT STEP"}</p><h2 id={label}>{title}</h2></div><button className="fd-icon" onClick={onClose} type="button" aria-label="Close this review"><X size={20}/></button></header>{children}{error&&<p className="fd-inline-error" role="alert">{error}</p>}</div></dialog>;
}
export function Acknowledgement({children,checked,onChange,disabled=false}:{children:ReactNode;checked:boolean;onChange:(checked:boolean)=>void;disabled?:boolean}){return <label className="fd-ack"><input type="checkbox" checked={checked} onChange={event=>onChange(event.target.checked)} disabled={disabled} required/><span>{children}</span></label>;}
export function FormActions({busy,disabled,label,onCancel}:{busy:boolean;disabled?:boolean;label:string;onCancel:()=>void}){return <div className="fd-form-actions"><button type="button" className="button secondary" onClick={onCancel}>Go back</button><button className="button primary" disabled={busy||disabled}>{busy?"Saving your decision…":label}<ArrowUpRight size={16}/></button></div>;}
