import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../domain/money";
import { verifiedPayPalProfileSchema } from "../domain/identity";
import { applicationOrigin, providerConfiguration } from "./payments";
import { tokenHash, type Session } from "./auth";
import { database, query } from "./db";
import { appendEvent } from "./repository";

export async function identityStart(session: Session):Promise<string>{
  if(session.mode!=="live_sandbox" || !["volunteer","donor"].includes(session.role)) throw new DomainError("ROLE_DENIED","Open your own live sandbox workspace before linking a recipient account.",403);
  const state=randomBytes(32).toString("base64url");
  await query("INSERT INTO fp_identity_states(state_hash,session_id,expires_at) VALUES($1,$2,$3)",[tokenHash(state),session.id,new Date(Date.now()+10*60*1000)]);
  const url=new URL("https://www.sandbox.paypal.com/connect");
  url.search=new URLSearchParams({flowEntry:"static",client_id:providerConfiguration().clientId,response_type:"code",scope:"openid https://uri.paypal.com/services/paypalattributes",fullPage:"true",redirect_uri:`${applicationOrigin()}/api/auth/paypal/callback`,state}).toString();
  return url.toString();
}
export function sealDestination(payerId:string,tenantId:string,actorId:string):string{
  const secret=process.env.AUTH_SECRET;
  if(!secret || secret.length<32) throw new Error("Recipient encryption requires AUTH_SECRET.");
  const key=createHash("sha256").update(`fieldproof-recipient-v1:${secret}`).digest(),iv=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",key,iv);
  cipher.setAAD(Buffer.from(`${tenantId}:${actorId}`));
  const encrypted=Buffer.concat([cipher.update(payerId,"utf8"),cipher.final()]);
  return ["v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),encrypted.toString("base64url")].join(".");
}
export async function completeIdentity(session:Session,state:string,code:string):Promise<void>{
  const result=await query("UPDATE fp_identity_states SET consumed_at=now() WHERE state_hash=$1 AND session_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash",[tokenHash(state),session.id]);
  if(!result.length) throw new DomainError("IDENTITY_STATE_INVALID","This account-linking request expired or was already used. Start again.",400);
  const config=providerConfiguration();
  const tokenResponse=await fetch(`${config.baseUrl}/v1/oauth2/token`,{method:"POST",headers:{Authorization:`Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:new URLSearchParams({grant_type:"authorization_code",code}),signal:AbortSignal.timeout(15000),cache:"no-store"});
  if(!tokenResponse.ok) throw new DomainError("IDENTITY_EXCHANGE_FAILED","PayPal could not complete the account connection. Start a fresh connection.",502);
  const token=z.object({access_token:z.string().min(1),token_type:z.string()}).safeParse(await tokenResponse.json());
  if(!token.success || token.data.token_type.toLowerCase()!=="bearer") throw new DomainError("IDENTITY_TOKEN_UNCONFIRMED","PayPal's account connection response could not be confirmed.",502);
  const response=await fetch(`${config.baseUrl}/v1/identity/openidconnect/userinfo?schema=openid`,{headers:{Authorization:`Bearer ${token.data.access_token}`,Accept:"application/json"},signal:AbortSignal.timeout(15000),cache:"no-store"});
  if(!response.ok) throw new DomainError("IDENTITY_PROFILE_FAILED","PayPal could not confirm your account information.",502);
  const profileResponse:unknown=await response.json();
  const parsed=verifiedPayPalProfileSchema.safeParse(profileResponse);
  if(!parsed.success) {
    const fields=profileResponse && typeof profileResponse==="object" ? profileResponse as Record<string,unknown> : {};
    // Log contract shape only; never identity values, access tokens, or the provider body.
    console.warn(JSON.stringify({event:"identity.attributes_unconfirmed",fields:Object.keys(fields).sort(),payerIdPresent:typeof fields.payer_id==="string"&&fields.payer_id.length>0,verificationType:typeof fields.verified_account,verificationTrue:fields.verified_account===true,verificationStringTrue:fields.verified_account==="true"}));
    throw new DomainError("IDENTITY_ATTRIBUTES_MISSING","PayPal did not return both a verified account and a payer ID. No repayment destination was approved.",422);
  }
  const profile=parsed.data;
  const masked=profile.email?`${profile.email.slice(0,1)}•••@${profile.email.split("@")[1]}`:`PayPal •••${profile.payer_id.slice(-4)}`;
  const encrypted=sealDestination(profile.payer_id,session.tenantId,session.actorId);
  await database().transaction(async tx=>{
    await tx.query("INSERT INTO fp_recipient_accounts(id,tenant_id,actor_id,encrypted_destination,masked_label,verification_method,account_verified,verified_at) VALUES($1,$2,$3,$4,$5,'paypal_identity',true,now()) ON CONFLICT(tenant_id,actor_id) DO UPDATE SET encrypted_destination=EXCLUDED.encrypted_destination,masked_label=EXCLUDED.masked_label,version=fp_recipient_accounts.version+1,verified_at=now(),account_verified=true",[randomUUID(),session.tenantId,session.actorId,encrypted,masked]);
    await tx.query("UPDATE fp_approval_records SET revoked_at=now() WHERE tenant_id=$1 AND actor_id=$2 AND data->>'operation'='payout' AND revoked_at IS NULL",[session.tenantId,session.actorId]);
    await appendEvent(tx,session,"recipient.verified","Your PayPal account is linked","Account ownership was checked through PayPal. A reviewed expense and a separate payment approval are still required.");
  });
}
export async function recipientView(session:Session){
  const [row]=await query<{masked_label:string;verification_method:string;account_verified:boolean;version:number;verified_at:Date}>("SELECT masked_label,verification_method,account_verified,version,verified_at FROM fp_recipient_accounts WHERE tenant_id=$1 AND actor_id=$2",[session.tenantId,session.actorId]);
  return row?{label:row.masked_label,method:row.verification_method,verified:row.account_verified,version:row.version,verifiedAt:row.verified_at.toISOString()}:null;
}
