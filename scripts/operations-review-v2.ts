import path from "node:path";
import { fileURLToPath } from "node:url";
import { OperationsError, requireOperation } from "../lib/operations/contracts";
import { reviewOperationsV2 } from "../lib/operations/review";
import { reviewLockedSecurity } from "../lib/operations/dependency-security";
import { writePrivateFile } from "../lib/operations/operator-files";

export async function runOperationsReviewV2(args: readonly string[], output: (value: unknown) => void = value => console.log(JSON.stringify(value))) {
  requireOperation((args.length === 2 || args.length === 4 && args[2] === "--security" && args[3] === "official-registry") && args[0] === "--out" && path.isAbsolute(args[1]), "INVALID_CONFIGURATION", "Use --out with an explicit private absolute file path, and optionally --security official-registry for public read-only npm/GitHub queries.");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const offline = await reviewOperationsV2(root);
  const review = { ...offline, security: args.length === 4 ? await reviewLockedSecurity(root) : { requested: false, status: "offline-inventory-is-not-an-advisory-clearance" } };
  await writePrivateFile(args[1], JSON.stringify(review, null, 2));
  const result = { ok: true, tables: review.tables, schemaVersion: review.schemaVersion, lockedPackages: review.dependencies.lockedPackages, undeclaredLicenses: review.dependencies.undeclared.length, commercialLicenseDeclarations: review.dependencies.licenseReview.commercial.length, licenseClearance: "operator-review-required", security: "affectedInstances" in review.security ? { affectedInstances: review.security.affectedInstances, uniqueAdvisories: review.security.uniqueAdvisories, upstreamComplete: review.security.upstreamComplete, securityClearance: false } : review.security, cleanupAuthorized: false, productionTransfer: "not-run", providerCalls: false };
  output(result); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runOperationsReviewV2(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error instanceof OperationsError ? error.code : "OPERATION_STOPPED", message: error instanceof OperationsError ? error.message : "The offline source review could not complete." })); process.exitCode = 1; }
}
