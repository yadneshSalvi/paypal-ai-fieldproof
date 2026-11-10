import { canonicalJson, payloadHash, sha256, type AuthorizationDecision, type PaymentCommand } from "@fracture/paypal-core";
import type { ApprovalRecord } from "../contracts";
import { conditionalPolicy, consentDigest } from "../domain/consent";
import { query } from "./db";
import { requireMembership } from "./membership";
import { readPaymentCommand } from "./stored-commands";
import { openPrivate } from "./private-values";

export const CONDITIONAL_COLLECTION_POLICY = sha256("Fieldproof:conditional-collection:v1:USD96000:eight-exact-consents:48h:exclusive-channel:current-membership");
export interface FrozenRoundData {
  intentId: string; organizerId: string; organizerMembershipVersion: number;
  dispatchMode?: "review_each" | "automatic";
  consents: { id: string; version: number; digest: string; actorId: string; membershipVersion: number; amountMinor: number }[];
}
function denied(command: PaymentCommand, reason: string): AuthorizationDecision {
  return { allowed: false, reason, resourceIds: [], currency: "USD", maximumMinor: 0, approvalId: command.approval.id, approvalVersion: command.approval.version, approvalDigest: command.approval.digest };
}
export async function authorizeConditionalPayment(command: PaymentCommand): Promise<AuthorizationDecision> {
  const [row] = await query<{
    command: PaymentCommand; actor_id: string; obligation_id: string; obligation_version: number; amount_minor: string; channel: string;
    consent_id: string; consent_version: number; consent_digest: string; consent_policy: ReturnType<typeof conditionalPolicy>; consent_expires: Date; withdrawn_at: Date | null;
    encrypted_wallet: string | null; package_version: number; current_package_version: number; slot_index: number;
    round_state: string; recovery_ends_at: Date; round_data: FrozenRoundData; round_policy: string; item_operation_id: string | null;
    wallet_checked_at: Date | null; wallet_identity_hash: string | null;
    approval_data: ApprovalRecord; approval_revoked: Date | null; approval_expires: Date; mode: string;
  }>(`SELECT pc.command,o.id obligation_id,o.version obligation_version,o.amount_minor,o.channel,c.actor_id,
    c.id consent_id,c.version consent_version,c.policy_digest consent_digest,c.policy consent_policy,c.expires_at consent_expires,c.withdrawn_at,
    c.encrypted_wallet,c.package_version,c.slot_index,p.version current_package_version,
    r.state round_state,r.recovery_ends_at,r.data round_data,r.policy_hash round_policy,
    i.operation_id item_operation_id,i.wallet_checked_at,i.wallet_identity_hash,
    a.data approval_data,a.revoked_at approval_revoked,a.expires_at approval_expires,t.mode
    FROM fp_payment_commands pc JOIN fp_obligations o ON o.id=pc.obligation_id
    JOIN fp_conditional_consents c ON c.obligation_id=o.id AND c.tenant_id=pc.tenant_id AND c.project_id=pc.project_id
    JOIN fp_collection_items i ON i.consent_id=c.id JOIN fp_collection_rounds r ON r.id=i.round_id AND r.id=c.round_id
    JOIN fp_packages p ON p.project_id=c.project_id AND p.id=c.package_id
    JOIN fp_approval_records a ON a.id=(pc.command->'approval'->>'id') JOIN fp_tenants t ON t.id=pc.tenant_id
    WHERE pc.operation_id=$1 AND pc.tenant_id=$2 AND pc.project_id=$3`, [command.operationId, command.scope.tenantId, command.scope.projectId]);
  if (!row) return denied(command, "The collection command has no frozen owned obligation.");
  const now = Date.now();
  if (row.mode !== "live_sandbox" || !["collecting", "recovering"].includes(row.round_state) || row.recovery_ends_at.getTime() <= now) return denied(command, "The fixed collection window is closed.");
  if (row.round_policy !== sha256(canonicalJson({ policy: CONDITIONAL_COLLECTION_POLICY, data: row.round_data, recoveryEndsAt: row.recovery_ends_at.toISOString(), packageVersion: row.package_version }))) return denied(command, "The frozen round digest no longer matches its terms.");
  if (row.withdrawn_at || row.consent_expires.getTime() <= now || row.package_version !== row.current_package_version || !row.encrypted_wallet) return denied(command, "The current consent or package is no longer eligible.");
  const frozen = row.round_data.consents.find(item => item.id === row.consent_id);
  if (!frozen || frozen.version !== row.consent_version || frozen.digest !== row.consent_digest || frozen.amountMinor !== Number(row.amount_minor) || frozen.actorId !== row.actor_id) return denied(command, "The frozen consent changed.");
  try {
    const [donor, organizer] = await Promise.all([
      requireMembership(command.scope.tenantId, command.scope.projectId, row.actor_id, "donor"),
      requireMembership(command.scope.tenantId, command.scope.projectId, row.round_data.organizerId, "organizer"),
    ]);
    if (donor.version !== frozen.membershipVersion || organizer.version !== row.round_data.organizerMembershipVersion) return denied(command, "Current membership differs from the approved collection round.");
  } catch { return denied(command, "An approving project membership was revoked."); }
  const expectedPolicy = conditionalPolicy(row.slot_index, row.package_version);
  const expectedDigest = consentDigest({ tenantId: command.scope.tenantId, projectId: command.scope.projectId, actorId: row.actor_id, obligationId: row.obligation_id, version: row.consent_version, policy: expectedPolicy });
  if (canonicalJson(row.consent_policy) !== canonicalJson(expectedPolicy) || expectedDigest !== row.consent_digest) return denied(command, "The consent policy does not match the exact original contribution.");
  if (canonicalJson(readPaymentCommand(row.command)) !== canonicalJson(command) || payloadHash(command.action) !== command.payloadHash) return denied(command, "The immutable collection command changed.");
  const approval = row.approval_data;
  if (row.approval_revoked || row.approval_expires.getTime() <= now || approval.policyHash !== CONDITIONAL_COLLECTION_POLICY || approval.resourceVersion !== row.obligation_version || approval.actorId !== row.actor_id || approval.digest !== command.approval.digest) return denied(command, "The exact payment approval is no longer valid.");
  if (command.action.money.currency !== "USD" || command.action.money.minor !== Number(row.amount_minor) || command.action.money.minor !== expectedPolicy.amountMinor) return denied(command, "The collection amount differs from the approved obligation.");
  if (!["uncollected", "original_in_flight", "unknown_reconciling"].includes(row.channel)) return denied(command, "Another collection channel owns this obligation.");
  if (!row.wallet_checked_at || now - row.wallet_checked_at.getTime() > 60000 || row.wallet_checked_at.getTime() > now + 5000) return denied(command, "Read the owned saved wallet again before collection.");
  const wallet = openPrivate<{ tokenId?: string }>(row.encrypted_wallet, `conditional-wallet:${command.scope.tenantId}:${row.actor_id}:${row.consent_id}`);
  if (!wallet.tokenId || row.wallet_identity_hash !== sha256(wallet.tokenId)) return denied(command, "The current saved wallet identity is unproved.");
  const resources = [wallet.tokenId];
  if (command.action.kind === "create_order") {
    const saved = command.action.savedWallet;
    if (!saved || saved.vaultId !== wallet.tokenId || saved.consentId !== row.consent_id || saved.consentVersion !== row.consent_version || saved.consentDigest !== row.consent_digest || saved.paymentInitiator !== "MERCHANT" || saved.usagePattern !== "UNSCHEDULED_PREPAID" || saved.usage !== "DERIVED" || command.action.customId !== row.obligation_id || command.action.intent !== "CAPTURE") return denied(command, "The saved-wallet command exceeds its consent.");
    return { allowed: true, reason: "Exact frozen conditional contribution", resourceIds: resources, currency: "USD", maximumMinor: expectedPolicy.amountMinor, approvalId: approval.id, approvalVersion: approval.resourceVersion, approvalDigest: approval.digest, savedWalletConsent: { ...saved, expiresAt: new Date(Math.min(row.consent_expires.getTime(), row.recovery_ends_at.getTime())).toISOString() } };
  }
  if (command.action.kind !== "capture_order") return denied(command, "This approval covers only the original conditional collection.");
  const owned = await query("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4", [command.action.orderId, command.scope.tenantId, command.scope.projectId, row.obligation_id]);
  if (!owned.length) return denied(command, "The order is outside the original obligation.");
  resources.push(command.action.orderId);
  return { allowed: true, reason: "Continuation of the same conditional order", resourceIds: resources, currency: "USD", maximumMinor: expectedPolicy.amountMinor, approvalId: approval.id, approvalVersion: approval.resourceVersion, approvalDigest: approval.digest };
}
