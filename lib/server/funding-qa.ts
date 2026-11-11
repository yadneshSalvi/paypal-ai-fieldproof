import { z } from "zod";
import { DomainError } from "../domain/money";
import { fundingQaEnabled } from "./provider-access";

const actorsSchema=z.array(z.object({key:z.string().regex(/^[a-z0-9-]{1,40}$/),label:z.string().min(1).max(100),detail:z.string().max(250),token:z.string().min(32).max(128)}).strict()).max(12);
export function fundingQaActors(){
  if(!fundingQaEnabled())throw new DomainError("NOT_FOUND","This review fixture is unavailable.",404);
  return actorsSchema.parse(JSON.parse(process.env.FIELDPROOF_FUNDING_QA_ACTORS??"[]"));
}
