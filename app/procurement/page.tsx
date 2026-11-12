import { cookies } from "next/headers";
import { ProcurementWorkspace } from "@/components/procurement/workspace";
import { DomainError } from "@/lib/domain/money";
import { getSession, sessionCookieName, tokenHash } from "@/lib/server/auth";
import { readProcurementContext, readProcurementDesk } from "@/lib/server/procurement-projection";

export const dynamic = "force-dynamic";
export default async function ProcurementPage() {
  const session = await getSession(), token = (await cookies()).get(sessionCookieName())?.value, context = await readProcurementContext(session, token ? tokenHash(token) : null);
  if (!session || !context.canRead) return <ProcurementWorkspace initialContext={context} initialDesk={null}/>;
  try { return <ProcurementWorkspace key={context.scope} initialContext={context} initialDesk={await readProcurementDesk(session, context.scope)}/>; }
  catch (error) { if (!(error instanceof DomainError)) throw error; return <ProcurementWorkspace initialContext={context} initialDesk={null} initialError={error.message}/>; }
}
