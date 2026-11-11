import { randomUUID } from "node:crypto";
import { canonicalJson, fromProviderMoney, sha256 } from "@fracture/paypal-core";
import type { BalancesResponse } from "paypal";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { paypalProvider, providerConfiguration } from "./payments";
import { sealPrivate } from "./private-values";

export const BALANCE_FETCH_MAX_AGE_MS = 60_000;
export const BALANCE_PROVIDER_MAX_AGE_MS = 3 * 60 * 60_000;
export interface BalanceEvidence {
  accountId: string; currency: "USD"; availableMinor: number; totalMinor: number; withheldMinor: number | null;
  asOfTime: string; lastRefreshTime: string; observedAt: string; bodyHash: string; source: "live_sandbox";
}
export type BalanceResult = { outcome: "observed"; evidence: BalanceEvidence } | { outcome: "unavailable"; code: string; httpStatus: number | null };
export interface BalanceReader { read(): Promise<BalanceResult> }

export function normalizeBalance(body: BalancesResponse, observedAt: string): BalanceEvidence {
  const usd = body.balances?.filter(balance => balance.currency === "USD") ?? [];
  if (usd.length !== 1 || !body.accountId || !/^[A-Za-z0-9]{5,64}$/.test(body.accountId) || !body.asOfTime || !body.lastRefreshTime)
    throw new DomainError("BALANCE_UNPROVEN", "The provider did not return one complete USD balance observation.", 503);
  const amount = (value: { currencyCode: string; value: string } | undefined): number => {
    if (!value || value.currencyCode !== "USD") throw new DomainError("BALANCE_CURRENCY_UNPROVEN", "The USD balance amount could not be confirmed.", 503);
    return fromProviderMoney(value).minor;
  };
  const availableMinor = amount(usd[0].availableBalance), totalMinor = amount(usd[0].totalBalance);
  const withheldMinor = usd[0].withheldBalance ? amount(usd[0].withheldBalance) : null;
  if (availableMinor > totalMinor || withheldMinor !== null && withheldMinor > totalMinor)
    throw new DomainError("BALANCE_INCOHERENT", "The provider balance components need reconciliation.", 503);
  for (const value of [observedAt, body.asOfTime, body.lastRefreshTime]) if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new DomainError("BALANCE_CLOCK_UNPROVEN", "The provider balance clocks could not be confirmed.", 503);
  return { accountId: body.accountId, currency: "USD", availableMinor, totalMinor, withheldMinor,
    asOfTime: new Date(body.asOfTime).toISOString(), lastRefreshTime: new Date(body.lastRefreshTime).toISOString(),
    observedAt, bodyHash: sha256(canonicalJson(body)), source: "live_sandbox" };
}
export function assertUsableBalance(evidence: BalanceEvidence, now = Date.now()): void {
  if (evidence.source !== "live_sandbox" || evidence.currency !== "USD") throw new DomainError("BALANCE_UNPROVEN", "Use an actual USD provider balance before repayment.", 409);
  const fetched = Date.parse(evidence.observedAt), asOf = Date.parse(evidence.asOfTime), refreshed = Date.parse(evidence.lastRefreshTime);
  if (![fetched, asOf, refreshed].every(Number.isFinite) || [fetched, asOf, refreshed].some(value => value > now))
    throw new DomainError("BALANCE_CLOCK_UNPROVEN", "The balance clocks are missing or ahead of the current time.", 409);
  if (now - fetched > BALANCE_FETCH_MAX_AGE_MS) throw new DomainError("BALANCE_FETCH_EXPIRED", "Read the current balance again before sending this repayment.", 409);
  if (now - asOf > BALANCE_PROVIDER_MAX_AGE_MS || now - refreshed > BALANCE_PROVIDER_MAX_AGE_MS)
    throw new DomainError("BALANCE_PROVIDER_STALE", "PayPal's balance snapshot is older than the three-hour reporting bound. Repayment remains reserved until a usable snapshot is available.", 409);
}
export const liveBalanceReader: BalanceReader = {
  async read() {
    try {
      const response = await paypalProvider().client.transactionSearch.searchBalances({ currencyCode: "USD" }, { signal: AbortSignal.timeout(20_000) }).asApiResult();
      if (!response.ok) return { outcome: "unavailable", code: `BALANCE_HTTP_${response.status}`, httpStatus: response.status };
      return { outcome: "observed", evidence: normalizeBalance(response.value, new Date().toISOString()) };
    } catch (error) {
      return { outcome: "unavailable", code: error instanceof DomainError ? error.code : "BALANCE_READ_UNAVAILABLE", httpStatus: null };
    }
  },
};
export function payoutMerchantScope(): string { return sha256(`fieldproof:sandbox:payout:${providerConfiguration().clientId}`); }
export async function observeBalance(reader: BalanceReader = liveBalanceReader): Promise<{ id: string; result: BalanceResult }> {
  const result = await reader.read(), id = randomUUID(), scope = payoutMerchantScope();
  const evidence = result.outcome === "observed" ? result.evidence : null;
  await query(`INSERT INTO fp_balance_observations(id,merchant_scope,account_hash,as_of_time,last_refresh_time,observed_at,available_minor,body_hash,code,encrypted_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, scope, evidence ? sha256(evidence.accountId) : null,
    evidence?.asOfTime ?? null, evidence?.lastRefreshTime ?? null, evidence?.observedAt ?? new Date().toISOString(), evidence?.availableMinor ?? null,
    evidence?.bodyHash ?? null, result.outcome === "unavailable" ? result.code : null, sealPrivate(result, `balance:${scope}:${id}`)]);
  return { id, result };
}
