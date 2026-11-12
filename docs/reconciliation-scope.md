# Reconciliation report scope

Studio's **Reconciliation · attention needed** table contains a specific subset of project issues visible to the current role at the report's database cutoff. An empty table means no rows from that subset were included. It does not establish complete application or merchant-wide reconciliation.

The producer is [`lib/server/studio-datasets.ts`](../lib/server/studio-datasets.ts); the semantic description is in [`lib/studio/native-data.ts`](../lib/studio/native-data.ts). This wording change adds no rows, financial action, permission or payload field.

| Included subset | Exact producer condition |
| --- | --- |
| Planning source issues | A published plan exists but its state is not current; one issue is recorded per package. |
| Work prerequisites | The current readiness projection identifies unmet prerequisites. |
| Collection shortfalls | A package has some collected value and a remaining shortfall. A package with no collection is not included by this condition alone. |
| Collection items | Stored collection items whose state is not `collected`, within the permitted project or donor-owned payment scope. An item without an operation is not a provider decline. |
| Incomplete refunds | Stored refunds whose state is not `completed`, within that permitted payment scope. This includes refused or not-sent outcomes; inclusion does not imply a pending transfer. |
| Held expense lines | Current claim-review lines marked `hold`, visible to the permitted broad role or the volunteer's own claim scope. |

Payout outcomes, actual-fee review, holds on original contribution returns, donor adjustment decisions and payment-command reconciliation errors may be visible in their separate repayment, funding, lifecycle or operator views. They are not all projected into this Studio table. Board Pack's attention section reuses this subset; its expense section separately retains repayment states, delivered/returned principal, fee allowance and nullable actual fees.

Verified but unmatched provider events remain in the worker's retry/review path until original ownership can be established. They cannot be attributed to a project or counted as a complete merchant-wide transaction denominator merely because an event arrived.

Amounts on issue rows can overlap. They must not be summed into a balance. Original receipt gross, current-purpose credit, completed and pending returns, exclusions, excess liabilities, principal, fee allowance and observed actual fees remain separate accounting facts. An unobserved actual fee remains unknown, not zero.

A database cutoff is separate from a provider observation time. Stored outcomes may lag the provider, and a pending or unknown result remains unconfirmed. Board Pack's earlier balance observation is historical evidence; repayment dispatch separately requires the existing fresh-fetch and provider-clock checks. A report does not reserve provider funds or authorize a new financial action.

Use wording such as: **Recorded project accounting at this cutoff; source observations may lag, unresolved outcomes remain unconfirmed, and merchant-wide reconciliation is unavailable.** A zero-row attention view is not a closed-books certificate. Saved historical reports retain their original rows and cutoff; they are not reconstructed from today's issue set.
