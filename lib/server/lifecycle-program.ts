import { randomUUID } from "node:crypto";
import * as C from "../lifecycle/contracts";
import { DomainError } from "../domain/money";
import { sealPrivate } from "./private-values";
import { assertOrganizationCurrent, orgHash, orgNow } from "./organization-core";
import { findLifecycleCommand, lifecycleActor, lifecycleAudit, lifecyclePrivateContext, lifecycleTx, lifecycleVersion, lifecycleWritable, readLifecycleProgram, saveLifecycleCommand, lifecycleCredential, requireLifecycleOrganization, type LifecycleProgramGrant, type LifecycleRequest } from "./lifecycle-core";

/** An organization opts into private drafting only. No destination, external
 * send, model dispatch or project role is implied by this durable opt-in. */
export async function changeLifecycleProgram(request: LifecycleRequest, action: "enable" | "disable", raw: unknown) {
  const input = action === "enable" ? C.lifecycleProgramEnableSchema.parse(raw) : C.lifecycleProgramDisableSchema.parse(raw), kind = action === "enable" ? "program_enable" : "program_disable";
  return lifecycleTx(async tx => {
    await lifecycleWritable(tx);
    const identity = await requireLifecycleOrganization(tx, request, input.expectedScope, true), actor = lifecycleActor(identity);
    const prior = await findLifecycleCommand(tx, actor, input, kind);
    if (prior) { await assertOrganizationCurrent(tx, request, identity); return { receipt: prior }; }
    const current = await readLifecycleProgram(tx, identity, true); lifecycleVersion(current.head?.version ?? 0, input.expectedVersion, "organization opt-in");
    const at = await orgNow(tx), maximum = Math.min(identity.session.expires_at.getTime(), identity.member.expires_at.getTime());
    let expiresAt: string;
    if (action === "enable" && "expiresAt" in input) {
      if (current.view.state === "enabled") throw new DomainError("LIFECYCLE_REVIEW_REQUIRED", "The original organization opt-in is already enabled. Retain its fixed deadline; disabling and a new explicit review are separate decisions.", 409);
      if (Date.parse(input.expiresAt) <= at.getTime() || Date.parse(input.expiresAt) > maximum) throw new DomainError("LIFECYCLE_EXPIRED", "Choose a future deadline within this original organization profile's unchanged access window.", 422);
      expiresAt = input.expiresAt;
    } else {
      if (!current.row || current.head?.state !== "enabled") throw new DomainError("LIFECYCLE_PROGRAM_DISABLED", "This organization opt-in is already disabled. Its original records remain retained.", 409);
      expiresAt = current.row.expires_at.toISOString();
    }
    const id = randomUUID(), version = (current.head?.version ?? 0) + 1, state = action === "enable" ? "enabled" : "disabled";
    const grant: LifecycleProgramGrant = { request: lifecycleCredential(request, false), originalSessionId: identity.session.id, originalMembershipId: identity.member.id,
      originalMembershipVersion: identity.member.version, originalRole: identity.member.role as "owner"|"coordinator", expiresAt };
    await tx.query("INSERT INTO fp_lifecycle_program_versions(id,organization_id,version,state,issuer_session_id,issuer_membership_id,issuer_membership_version,issuer_role,expires_at,encrypted_grant,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id, identity.organization.id, version, state, identity.session.id, identity.member.id, identity.member.version, identity.member.role, expiresAt, sealPrivate(grant, lifecyclePrivateContext("program",id)), orgHash(grant)]);
    await tx.query("INSERT INTO fp_lifecycle_program_heads(organization_id,version,current_version_id,state) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id) DO UPDATE SET version=EXCLUDED.version,current_version_id=EXCLUDED.current_version_id,state=EXCLUDED.state,updated_at=clock_timestamp()", [identity.organization.id, version, id, state]);
    await lifecycleAudit(tx, { organizationId: identity.organization.id }, actor, kind, id, { state, originalExpiresAt: expiresAt, previousVersion: current.head?.version ?? 0, newVersion: version, reason: "reason" in input ? input.reason : "Explicit private-draft opt-in; no external delivery authorization.", externalSendingAuthorized: false });
    const receipt = await saveLifecycleCommand(tx, actor, input, kind, { resourceId: id, resourceVersion: version, message: action === "enable" ? "Private organization drafting is enabled until the reviewed fixed deadline. Every schedule still needs its own exact authority and source review." : "Future organization draft production is disabled. Original occurrences, sources and deadlines remain retained." });
    await assertOrganizationCurrent(tx, request, identity);
    return { receipt };
  });
}
