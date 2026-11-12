import { z } from "zod";
import { DomainError } from "../domain/money";
import { supporterQaEnabled } from "./provider-access";
import type { Session } from "./auth";

const actorsSchema=z.array(z.object({key:z.string().regex(/^[a-z0-9-]{1,40}$/),label:z.string().min(1).max(100),detail:z.string().max(250),token:z.string().min(32).max(128)}).strict()).max(12);
export function supporterQaActors(){
  if(!supporterQaEnabled())throw new DomainError("NOT_FOUND","This review fixture is unavailable.",404);
  return actorsSchema.parse(JSON.parse(process.env.FIELDPROOF_SUPPORTER_QA_ACTORS??"[]"));
}
/** Frozen, disposable race projects only. Normal product and review reads do
 * not wait; a delayed read still rechecks every source before disclosing it. */
export async function supporterQaReadDelay(session:Session) {
  if(!supporterQaEnabled())return;
  const projects=z.array(z.uuid()).max(8).parse(JSON.parse(process.env.FIELDPROOF_SUPPORTER_QA_DELAY_PROJECTS??"[]"));
  if(projects.includes(session.projectId))await new Promise(resolve=>setTimeout(resolve,15_000));
}
