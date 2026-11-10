"use client";
import {useEffect,useRef,useState} from "react";
import { ArrowUpRight, Check, Clock3, RotateCw, ShieldCheck } from "lucide-react";
import type {ProjectSnapshot} from "@/lib/contracts";
import type {PaymentView} from "@/lib/server/payments";

interface PayPalButtons {render(element:HTMLElement):Promise<void>;close():Promise<void>}
interface PayPalApi {Buttons(options:{style:Record<string,unknown>;createOrder:()=>Promise<string>;onApprove:(data:{orderID:string})=>Promise<void>;onCancel:()=>void;onError:()=>void}):PayPalButtons}
declare global {interface Window {paypal?:PayPalApi}}
async function post<T>(url:string,body:unknown):Promise<T>{const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error??"The request could not finish.");return value as T;}
let sdkPromise:Promise<void>|undefined;
function loadPayPal(clientId:string):Promise<void>{
  if(window.paypal)return Promise.resolve();
  if(!sdkPromise)sdkPromise=new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    const query=new URLSearchParams({"client-id":clientId,components:"buttons",currency:"USD",intent:"capture","disable-funding":"card,credit,paylater"});
    script.src=`https://www.paypal.com/sdk/js?${query}`;script.async=true;
    script.onload=()=>resolve();script.onerror=()=>{sdkPromise=undefined;script.remove();reject(new Error("PayPal could not load. Check your connection and try again."));};
    document.head.append(script);
  });
  return sdkPromise;
}
export function SandboxCheckout({snapshot,onStart,onRefresh}:{snapshot:ProjectSnapshot;onStart:()=>Promise<void>;onRefresh:()=>Promise<void>}){
  const mount=useRef<HTMLDivElement>(null),intent=useRef<string>(""),returnedOrder=useRef<string|null>(null);
  const refreshRef=useRef(onRefresh);refreshRef.current=onRefresh;
  const [payment,setPayment]=useState<PaymentView|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[ready,setReady]=useState(false),[retry,setRetry]=useState(0);
  const isLive=snapshot.mode==="live_sandbox" && !!snapshot.session;
  useEffect(()=>{
    if(!isLive || snapshot.session?.role!=="donor")return;
    let disposed=false,buttons:PayPalButtons|undefined;
    const storageKey=`fieldproof-checkout:${snapshot.id}`;
    const saved=localStorage.getItem(storageKey);
    if(saved){try{const record=JSON.parse(saved);intent.current=record.intentId;if(record.payment)setPayment(record.payment);}catch{localStorage.removeItem(storageKey);}}
    if(!intent.current)intent.current=crypto.randomUUID();
    if(!saved)localStorage.setItem(storageKey,JSON.stringify({intentId:intent.current,payment:null}));
    const remember=(value:PaymentView)=>{if(!disposed){setPayment(value);localStorage.setItem(storageKey,JSON.stringify({intentId:intent.current,payment:value}));}};
    if(saved){try{if(JSON.parse(saved).payment?.captureId)return;}catch{/* The invalid saved record was cleared above. */}}
    (async()=>{
      try{
        setLoading(true);setError(null);
        const response=await fetch("/api/paypal/config"),config=await response.json();
        if(!response.ok || !config.clientId)throw new Error(config.error??"The PayPal sandbox connection is not available.");
        await loadPayPal(config.clientId);
        if(disposed || !mount.current || !window.paypal)return;
        buttons=window.paypal.Buttons({style:{layout:"vertical",color:"gold",shape:"rect",label:"pay",height:48},
          createOrder:async()=>{setError(null);const value=await post<PaymentView>("/api/checkout/create",{intentId:intent.current});remember(value);if(!value.orderId || value.status!=="succeeded")throw new Error(value.message??"The original order is being checked. Use Check status before trying anything else.");return value.orderId;},
          onApprove:async data=>{setLoading(true);try{remember(await post<PaymentView>("/api/checkout/capture",{intentId:intent.current,orderId:data.orderID}));await refreshRef.current();}catch(e){setError(e instanceof Error?e.message:"The payment result needs checking.");}finally{setLoading(false);}},
          onCancel:()=>setError("Checkout closed. You can check the original operation or return when you are ready."),
          onError:()=>setError("PayPal checkout could not finish. Check the original operation before starting another payment."),
        });
        await buttons.render(mount.current);if(!disposed)setReady(true);
      }catch(e){if(!disposed)setError(e instanceof Error?e.message:"Checkout could not load.");}
      finally{if(!disposed)setLoading(false);}
    })();
    return()=>{disposed=true;void buttons?.close().catch(()=>{});};
  },[isLive,snapshot.id,snapshot.session?.role,retry,payment?.captureId]);
  useEffect(()=>{
    if(!isLive || snapshot.session?.role!=="donor" || !payment?.orderId || payment.captureId)return;
    const params=new URLSearchParams(window.location.search),orderId=params.get("token");
    if(params.get("checkout")!=="returned" || orderId!==payment.orderId || returnedOrder.current===orderId)return;
    returnedOrder.current=orderId;
    setLoading(true);setError(null);
    // The server checks ownership, the exact approval, and PayPal's buyer-approved state.
    void post<PaymentView>("/api/checkout/capture",{intentId:intent.current,orderId}).then(async value=>{
      setPayment(value);
      localStorage.setItem(`fieldproof-checkout:${snapshot.id}`,JSON.stringify({intentId:intent.current,payment:value}));
      await refreshRef.current();
    }).catch(e=>setError(e instanceof Error?e.message:"The original payment needs checking.")).finally(()=>setLoading(false));
  },[isLive,payment,snapshot.id,snapshot.session?.role]);
  const check=async()=>{
    if(!intent.current)return;setLoading(true);setError(null);
    try{const next=await post<PaymentView>("/api/checkout/check-intent",{intentId:intent.current});setPayment(next);localStorage.setItem(`fieldproof-checkout:${snapshot.id}`,JSON.stringify({intentId:intent.current,payment:next}));await onRefresh();}
    catch(e){setError(e instanceof Error?e.message:"Status could not be checked.");}finally{setLoading(false);}
  };
  return <div className="checkout-layout">
    <div><p className="eyebrow">REAL CONNECTION · TEST FUNDS</p><h1>A small payment.<br/>A real paper trail.</h1><p className="lead-copy">Try one $1.00 contribution through PayPal's sandbox. You approve it in PayPal. Fieldproof records it only when the payment is confirmed.</p><div className="soft-note"><ShieldCheck size={22}/><p>This is a separate test workspace. Sample pledges and sample receipts never become live funding. This checkout does not enable future automatic charges.</p></div><div className="step-list"><p><span>01</span>Open your own sandbox workspace</p><p><span>02</span>Approve $1.00 with a PayPal sandbox buyer</p><p><span>03</span>Follow the confirmed receipt into your ledger</p></div></div>
    <div className="checkout-card"><div className="card-top"><span className="eyebrow">YOUR TEST CONTRIBUTION</span><span className="status-pill">Sandbox</span></div><h2>$1<span>.00</span></h2><p>Electronics benches · USD</p><div className="rule"/>
      {!isLive?<button className="button primary full" onClick={()=>{setLoading(true);onStart().catch(e=>setError(e.message)).finally(()=>setLoading(false));}} disabled={loading}>{loading?"Opening your workspace…":"Open live sandbox workspace"}<ArrowUpRight size={18}/></button>:snapshot.session?.role!=="donor"?<p className="soft-note">Choose the Donor role to approve your own payment. The Auditor cannot create or capture payments.</p>:!payment?.captureId?<><p className="checkout-consent">I approve one $1.00 sandbox test payment when I complete PayPal checkout.</p><div ref={mount} className="paypal-mount" aria-label="Official PayPal checkout buttons"/>{loading&&!ready&&<p className="loading-line">Connecting to PayPal…</p>}</>:<a className="button primary full" href="/my-contribution">Follow your contribution<ArrowUpRight size={18}/></a>}
      {payment&&<div className={`payment-result ${payment.captureId?"settled":""}`} aria-live="polite"><div>{payment.captureId?<Check size={20}/>:<Clock3 size={20}/>}<strong>{payment.captureId?"PayPal confirmed the payment":payment.status==="pending_reconciliation"?"Checking the original payment":"Your original payment request"}</strong></div><dl><div><dt>Operation</dt><dd>…{payment.operationId.slice(-8)}</dd></div>{payment.captureId&&<div><dt>Capture</dt><dd>…{payment.captureId.slice(-8)}</dd></div>}<div><dt>Observed state</dt><dd>{payment.status.replaceAll("_"," ")}</dd></div></dl><button className="text-button" onClick={check} disabled={loading}><RotateCw size={15}/>{loading?"Checking…":"Check original status"}</button></div>}
      {payment?.approvalUrl&&!payment.captureId&&payment.status==="succeeded"&&<div className="soft-note"><p>Payment window blocked? Continue securely in this tab using your original order.</p><a className="text-button" href={payment.approvalUrl}>Continue with PayPal<ArrowUpRight size={16}/></a></div>}
      {error&&<div className="inline-error" role="alert">{error}{!ready&&isLive&&<button onClick={()=>setRetry(v=>v+1)} className="text-button">Try loading checkout again</button>}{isLive&&!payment&&<button onClick={check} disabled={loading} className="text-button">Check original status</button>}</div>}
      <p className="fine-print">Use a sandbox buyer account. No real currency moves. Card details and PayPal passwords stay with PayPal.</p>
    </div>
  </div>;
}
