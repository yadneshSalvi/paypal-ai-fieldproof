import { randomUUID } from "node:crypto";
import type { Session } from "./auth";
import { query } from "./db";
import { presentedDeadline, type SampleTimeline } from "./seed";

/** What /judge needs to know about the visitor's own scenario. Never includes another tenant's data. */
export interface JudgeScenarioView {
  version: number; projectId: string; mintedAt: string; deadline: string; sessionExpiresAt: string;
  collectionStartedAt: string; recoveryEndsAt: string; declineObservedAt: string;
  tourStep: number; pristine: boolean; role: Session["role"];
  /** The seeded postponed purpose whose supporters choose a return or another purpose. */
  cancellation: { title: string; deadline: string; shares: number } | null;
}
interface ProjectRow { tour_step: number; metadata: { deadline?: string; sampleTimeline?: SampleTimeline; judgeScenario?: { version: number; mintedAt: string } }; mode: Session["mode"] }
const DAY_MS = 24 * 60 * 60 * 1000;
export const JUDGE_DECISION_DAYS = 14;

async function projectRow(session: Pick<Session, "tenantId" | "projectId">): Promise<ProjectRow | null> {
  const [row] = await query<ProjectRow>("SELECT p.tour_step,p.metadata,t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2", [session.projectId, session.tenantId]);
  return row ?? null;
}
/** Null for no session, a live-sandbox workspace, or a Sample workspace that was not minted as a judge scenario. */
export async function judgeScenario(session: Session | null): Promise<JudgeScenarioView | null> {
  if (!session || session.mode !== "sample") return null;
  const row = await projectRow(session);
  if (!row?.metadata.judgeScenario || !row.metadata.sampleTimeline) return null;
  const [untouched] = await query<{ ok: boolean }>(`SELECT (SELECT channel FROM fp_obligations WHERE id=$3 AND tenant_id=$1 AND project_id=$2)='definitively_declined'
    AND NOT EXISTS(SELECT 1 FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 AND package_id='electronics')
    AND COALESCE((SELECT data->>'fundingState' FROM fp_packages WHERE project_id=$2 AND id='electronics'),'') NOT IN ('cancelled','compensating') AS ok`, [session.tenantId, session.projectId, `${session.projectId}-obligation-hero-8`]);
  const [openCase] = await query<{ deadline: Date; title: string; shares: string }>(`SELECT c.deadline,p.data->>'title' AS title,
    (SELECT count(*) FROM fp_settlement_receipts r WHERE r.tenant_id=c.tenant_id AND r.project_id=c.project_id AND r.package_id=c.package_id) AS shares
    FROM fp_funding_cases c JOIN fp_packages p ON p.project_id=c.project_id AND p.id=c.package_id
    WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.state<>'superseded' ORDER BY c.created_at LIMIT 1`, [session.tenantId, session.projectId]);
  const timeline = row.metadata.sampleTimeline;
  return {
    version: row.metadata.judgeScenario.version, projectId: session.projectId, mintedAt: timeline.mintedAt, deadline: presentedDeadline(row.metadata.deadline, "sample"),
    sessionExpiresAt: session.expiresAt, collectionStartedAt: timeline.collectionStartedAt, recoveryEndsAt: timeline.recoveryEndsAt, declineObservedAt: timeline.declineObservedAt,
    tourStep: row.tour_step, pristine: row.tour_step === 0 && !!untouched?.ok, role: session.role,
    cancellation: openCase ? { title: openCase.title, deadline: openCase.deadline.toISOString(), shares: Number(openCase.shares) } : null,
  };
}
async function scenarioVersion(session: Session | null): Promise<number> {
  if (!session) return 0;
  return (await projectRow(session))?.metadata.judgeScenario?.version ?? 0;
}
/**
 * Fills the desks around the hero for one freshly minted judge tenant, through the same
 * organizer commands a person would use: the Woodworking corner (three Sample Orders
 * captures, one of them the visitor's) is postponed, which opens a donor decision, and
 * Student materials is opened as a purpose a share can move to. Sample only: no provider
 * is called. A failure here never blocks the hero story.
 */
export async function seedJudgeDesks(session: Session): Promise<{ seeded: boolean; code: string | null }> {
  if (session.mode !== "sample") return { seeded: false, code: "SAMPLE_ONLY" };
  const organizer: Session = { ...session, role: "organizer" };
  try {
    await query("UPDATE fp_sessions SET role='organizer' WHERE id=$1 AND revoked_at IS NULL", [session.id]);
    const { cancellationCaseReview, createFundingPolicy, openCancellationCase } = await import("./funding-lifecycle");
    const [materials] = await query<{ version: number }>("SELECT version FROM fp_packages WHERE project_id=$1 AND id='materials'", [session.projectId]);
    await createFundingPolicy(organizer, { intentId: randomUUID(), packageId: "materials", expectedVersion: materials.version, kind: "mixed", acknowledged: true });
    const review = await cancellationCaseReview(organizer, "woodworking");
    await openCancellationCase(organizer, { intentId: randomUUID(), packageId: "woodworking", expectedVersion: review.packageVersion, reviewDigest: review.digest,
      reason: "Sample story: the woodworking corner is postponed to next term. Each supporter chooses a return of their share or another current purpose.",
      deadline: new Date(Date.now() + JUDGE_DECISION_DAYS * DAY_MS).toISOString(), acknowledged: true });
    return { seeded: true, code: null };
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "JUDGE_DESK_SEED_FAILED";
    console.error(JSON.stringify({ event: "judge.desk_seed_skipped", code }));
    return { seeded: false, code };
  } finally {
    await query("UPDATE fp_sessions SET role=$2 WHERE id=$1 AND revoked_at IS NULL", [session.id, session.role]);
  }
}
/** Cookie-free core, used by the request wrappers below and by tests. Nothing of `previous` is changed. */
export async function mintJudgeScenario(previous: Session | null): Promise<{ session: Session; token: string; version: number }> {
  const { createSessionRecord } = await import("./auth");
  const version = await scenarioVersion(previous) + 1;
  const minted = await createSessionRecord("sample", { judge: { version } });
  await seedJudgeDesks(minted.session);
  return { ...minted, version };
}
/** Ends only the given browser session. Its tenant, records and any provider history stay exactly as they were. */
export async function revokeJudgeSession(session: Pick<Session, "id" | "tenantId">): Promise<boolean> {
  const rows = await query("UPDATE fp_sessions SET revoked_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL RETURNING id", [session.id, session.tenantId]);
  return rows.length === 1;
}

async function adopt(token: string): Promise<void> {
  const [{ cookies }, { sessionCookieName, sessionCookieSecure, SESSION_HOURS }, { rememberWorkspaceCookie }] = await Promise.all([import("next/headers"), import("./auth"), import("./community-workspaces")]);
  await rememberWorkspaceCookie(token);
  (await cookies()).set(sessionCookieName(), token, { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure(), path: "/", maxAge: SESSION_HOURS * 60 * 60 });
}
async function currentSession(): Promise<Session | null> {
  const [{ getSession }, { rememberWorkspaceCookie }] = await Promise.all([import("./auth"), import("./community-workspaces")]);
  const session = await getSession();
  // Keeps an earlier workspace reachable from Saved workspaces before this browser moves on.
  await rememberWorkspaceCookie();
  return session;
}
/**
 * "tour" needs an untouched hero, so it reuses the visitor's scenario only while that is
 * pristine and otherwise mints the next version (the earlier workspace stays open in Saved
 * workspaces). "workspace" keeps whatever judge scenario the visitor already has.
 */
export async function startJudgeScenario(intent: "tour" | "workspace"): Promise<{ session: Session; scenario: JudgeScenarioView; created: boolean }> {
  const current = await currentSession(), existing = await judgeScenario(current);
  if (current && existing && (intent === "workspace" || existing.pristine)) return { session: current, scenario: existing, created: false };
  const minted = await mintJudgeScenario(current);
  await adopt(minted.token);
  return { session: minted.session, scenario: (await judgeScenario(minted.session))!, created: true };
}
/** Start over: a new scenario version in a new tenant, then the old session is revoked. Nothing is deleted. */
export async function resetJudgeScenario(): Promise<{ session: Session; scenario: JudgeScenarioView; revokedPrevious: boolean }> {
  const current = await currentSession();
  const minted = await mintJudgeScenario(current);
  await adopt(minted.token);
  const revokedPrevious = current ? await revokeJudgeSession(current) : false;
  return { session: minted.session, scenario: (await judgeScenario(minted.session))!, revokedPrevious };
}
