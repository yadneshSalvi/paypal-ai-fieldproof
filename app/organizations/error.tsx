"use client";

import { OrgNotice, OrganizationShell } from "@/components/organizations/shared";

export default function OrganizationError({ retry }: { error: unknown; retry: () => void }) { return <OrganizationShell><section className="og-entry"><p className="og-kicker">ORGANIZATION ACCESS</p><h1>This view needs<br/><em>another check.</em></h1><OrgNotice title="The organization view could not open" error>Original memberships, decisions and saved editions remain unchanged. Retry the current view; an interrupted command retains its exact saved attempt.</OrgNotice><div className="og-actions"><button type="button" className="og-button" onClick={retry}>Check current view again</button><a className="og-button secondary" href="/organizations">Organization entry</a><a href="/community?return=/organizations">Project workspaces</a></div></section></OrganizationShell>; }
