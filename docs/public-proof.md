# Public Proof Pages

Open `/proof-desk` in a current organizer session. The publication desk creates a separate public projection; it never publishes a private project snapshot or a source-storage URL.

1. Choose a package. Select a validated receipt or photograph already available to the organizer. The planning desk can import a clearly fictional Sample image.
2. Crop the page and add opaque masks by dragging or using percentage controls. Preparing a copy rasterizes the masks before cropping, strips metadata, and writes a separate immutable private PNG. Inspect the exact result and approve its privacy review.
3. Select the reviewed copies and prepare an immutable edition. Funding uses the same all-rail SettlementReceipt projection as the workspace, including refund reserves, exclusions and excess liability. Physical sign-offs retain current reviewer scope and source lineage; an image or payment cannot supply one.
4. Review the full page, then separately publish the reviewed edition. A stable unpredictable slug opens `/proof/<slug>`. Each edition includes its package version, cutoff, SHA-256, reviewed derivative versions and only payment-reference suffixes.
5. Use **Full record** or **Hallway poster**, then choose **A4** or **Letter**. The QR always points to the stable current publication, while edition links identify historical snapshots. Public funding remains a dated total, not a merchant-balance observation.
6. Withdraw the page or a derivative when review is needed. Public JSON, QR and image requests check current publication/source/reviewer authority. All carry `private, no-store` headers. An already-open page rechecks every 15 seconds and on focus/visibility/pageshow; a prolonged inability to verify withholds old content. Browser scheduling can delay background-tab timers, so resuming the page triggers another check.

Private sources, donor identities, recipient destinations, credential evidence, signatures, source text, review notes, full provider IDs and secret URLs are absent from the constructed public payload. The organizer still must inspect the visible raster and public title before approval: software does not infer consent or guarantee that manual redaction is complete.

Revocation retains the private audit and cannot recall downloads, screenshots or printed copies. Source permission reinstatement does not revive a stale review. A new reviewed edition is needed. Changed funding, package versions, source permissions or review authority invalidate an unpublished draft. Published funding remains historical; withdrawn source/reviewer authority withholds the affected public evidence.

The additive schema adds `fp_proof_heads`, `fp_proof_derivatives` and `fp_proof_snapshots` at version 12. Publication actions use current session/membership checks, exact versions and idempotent action identities. Existing packages and financial rows are not migrated or rewritten. These routes introduce no provider payments, model calls, email or financial approvals.

## Validation

The focused suite covers exact review/publish separation, idempotence, concurrent drafts, cross-project/role isolation, expiry/revocation, stale money/source/package versions, all-rail privacy, immutable history, derivative/source withdrawal, private-byte integrity and actual raster-mask pixels/metadata removal. Run it in the isolated planning QA environment:

```sh
npm run planning:qa -- --test tests/public-proof.test.ts tests/database-initialization.test.ts
npm run planning:qa -- --build
npm run planning:qa -- --resume
```

The QA launcher uses a separate local database, cookie and document directory, disables financial providers, and binds poster URLs to port 4502. See `docs/planning-review.md` for creating that environment. Public publication tests use fictional Sample content only. They do not establish an independent human privacy review, real purchase, installation or professional inspection.

Qualification records distinguish local, native-browser and hosted results. Complete organization Board Packs, reviewed translations, broader funding/organization flows and remaining evaluation/research work remain separate requirements.

The organizer desk reports the effective public state, including withdrawal caused by source or review authority changes. Its retained publication history is not presented as currently available content.

## Font-independent image evidence

Hosted inspection found that the deployment's rasterizer had no system font for the authored Sample SVG text or the public-copy stamp. New imports use committed SVG copies whose lettering is converted to paths with the bundled IBM Plex fonts. Public-copy stamps use the same mechanism. Original editable illustrations, non-text geometry and existing stored evidence bytes are preserved. A fresh source import and fresh image review are required for a new rendition; earlier reviewed editions are never silently regenerated.

Run `npm run assets:outline` after editing an authored Sample SVG; `npm run assets:check` verifies every generated byte and the font/source hashes in `public/samples/outlined/manifest.json`. The generator converts only the text nodes because a whole-document SVG round-trip can lose pattern fills. The font license is retained at `public/asset-fonts/OFL.txt`. Next's server traces explicitly include the outlined inputs and both stamps. These image labels remain visible in a fontless runtime, while their surrounding accessible page supplies the text alternative.

The correction passed 48 focused public-proof, planning and receipt tests, TypeScript and the production build. Local image inspection checked the lettering and preserved floor pattern. Hosted rendition and native publication checks are recorded separately.

Public-page text links and QR codes share one origin resolver. On Vercel they point to the stable Fieldproof hostname, including when a deployment is being qualified at a preview hostname. Isolated planning QA keeps its own local port. The resolver does not change financial callback configuration and never trusts a request Host header.
