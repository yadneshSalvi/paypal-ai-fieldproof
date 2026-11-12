import type { WorkspaceRole } from "../contracts";

export const workspaceRoleLabels: Record<WorkspaceRole, string> = {
  donor: "Donor", volunteer: "Volunteer", organizer: "Organizer", auditor: "Auditor · read only",
};
/** Missing legacy capability metadata narrows to the active role. The server
 * supplies the current membership list; this is never a grant of authority. */
export function workspaceRoleOptions(current: WorkspaceRole, allowed?: WorkspaceRole[]): WorkspaceRole[] {
  return (["donor", "volunteer", "organizer", "auditor"] as WorkspaceRole[]).filter(role => role === current || allowed?.includes(role));
}
