# Shared-project supporter invitations

An organizer can open `/supporters`, create a donor or sponsor invitation, copy its private link, and share it directly with the intended recipient. No email or external message is sent by this flow. The recipient opens `/join#invite=…`, reviews the specific project, enters a self-declared name, and explicitly accepts. Joining creates no pledge, sponsor acceptance, payment, invoice, or refund.

## Authentication and scope

This is possession-based invitation access. An invitation is a random 384-bit one-use capability. It establishes a separate application actor, membership and session in exactly the issuing tenant and project. Both donor and sponsor invitations grant only `donor`; the sponsor distinction describes the invitation’s purpose and retains the existing actor-owned sponsor agreement and funding choices. Recipients cannot select an actor, project, tenant or role in their acceptance request. Existing payment authorization and donor ownership checks remain required.

Names are supplied by recipients. The flow does not verify a person, email address, organization, PayPal identity, or whether two browser sessions represent different humans. The inviting actor and the browser that issued the invitation cannot claim it themselves. These are application independence checks, not proof of independent human participation. An existing browser workspace must be explicitly saved and set aside before accepting or restoring a different identity. An ended credential must also be explicitly cleared.

Issuance requires a current organizer session and membership. Each acceptance checks that the original inviter still has active organizer authority at the exact membership version recorded when the invitation was issued. That membership is locked through acceptance. Copying an unused link repeats the authority check. An issuer’s expired browser session does not itself cancel an invitation if their membership remains current; membership revocation or version changes block unused invitations. Once accepted, the recipient’s grant is independent of the inviter’s session and is governed by its original terms and explicit revocation.

## Fixed lifetime and recovery

The organizer chooses a duration up to seven days. A single absolute expiry starts at issuance and bounds the invitation, accepted session and private return capability. Joining late, retries, reloads and returning from another browser never extend it. A rolling project limit allows at most sixty issued invitations in twenty-four hours; the desk includes every possible current grant under that limit before recent history.

Acceptance atomically consumes the invitation and writes the exact consent, actor, membership, session and private audit. Competing acceptances produce at most one grant. A retry from the same HttpOnly browser identity with the same intent and exact acceptance data returns that original session; a different intent, payload or browser cannot reuse the spent invitation. The organizer’s copy of the invitation token is removed after acceptance or revocation.

The recipient receives a separate private return link, `/join#access=…`. Possession restores the original session, subject to its unchanged membership, role, deadline and revocation state. It does not mint another session. The return key is intentionally a credential: the recipient must keep it private. Restoring it requires explicit confirmation and never silently replaces an unrelated active or ended credential. An organizer may withdraw either an unused invitation or accepted access. Withdrawal revokes the recipient’s membership and sessions, retains original expiry/provenance, and leaves all financial and decision history intact. It does not refund or transfer money.

Database clock checks occur after potentially delayed locks and writes, before the transaction returns access. An organizer or grant that expires while waiting cannot produce a successful mutation or recovered capability.

## Privacy and browser behavior

Raw invitation and return tokens appear only in authorized link responses and browser fragments. Fragments are not sent as request URLs. The client reads the link, saves its exact pending request in per-tab session storage where available, removes the fragment from the address bar, and submits it only in a same-origin JSON request body. Invitations and access pages use `no-referrer` and private, non-cacheable responses. Request bodies, fragments and names are not logged. Session tokens stay in HttpOnly cookies and are never returned as JSON.

The server hashes token lookups, encrypts retained capabilities, invitation labels, names, consent and audit data with scope-specific authenticated encryption, and keeps the grant/command/audit history append-only. Project events contain generic access facts, with no invitation labels, recipient names or credentials. Organizer listing responses contain private names and state but no token. A different active identity cannot preview the invited project or recipient until it explicitly sets its workspace aside.

Pending acceptance and restoration retain their original intent and exact body through a reload. If session storage is unavailable, the page keeps the request in memory and explains the reload limitation. Same-document fragment changes abort prior work and replace the reviewed link. Cross-tab identity changes abort pending reads and clear visible private details. Late background reads cannot overwrite a later organizer mutation. Clipboard failures select the complete link for manual copying; sharing uses the recipient device’s explicit sharing panel.

## Verification and local review

Meaningful PostgreSQL tests exercise actor separation, fixed expiry, current authority, exact retries, independent concurrent holders, revocation, donor-owned sponsor/pledge behavior, encrypted/private output and immutable history. Separate adversarial tests hold actual database locks across organizer and grant expiry and verify that access or audit writes roll back. These tests use controlled synthetic actors and provider transports; they are not evidence of real people or real payments.

The ordinary routes implement onboarding without a fixture chooser. The isolated native review profile only confines local configuration to its own database, cookie name and origin; it disables external providers and cannot run on a hosted process. Local review state, credentials and failure logs stay outside Git. Production HTTP and native browser qualification are recorded separately from service and pure client tests.

Full Fieldproof release still requires the remaining provider, model, accessibility, research, publication and operational gates. This invitation feature does not establish PayPal identity verification or human participation evidence.
