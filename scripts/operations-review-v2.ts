import path from "node:path";
import { fileURLToPath } from "node:url";
import { OperationsError, requireOperation } from "../lib/operations/contracts";
import { reviewOperationsV2 } from "../lib/operations/review";
import { writePrivateFile } from "../lib/operations/operator-files";

export async function runOperationsReviewV2(args: readonly string[], output: (value: unknown) => void = value => console.log(JSON.stringify(value))) {
  requireOperation(args.length === 2 && args[0] === "--out" && path.isAbsolute(args[1]), "INVALID_CONFIGURATION", "Use --out with an explicit private absolute file path.");
  const review = await reviewOperationsV2(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  await writePrivateFile(args[1], JSON.stringify(review, null, 2));
  const result = { ok: true, tables: review.tables, schemaVersion: review.schemaVersion, lockedPackages: review.dependencies.lockedPackages, undeclaredLicenses: review.dependencies.undeclared.length, commercialLicenseDeclarations: review.dependencies.licenseReview.commercial.length, licenseClearance: "operator-review-required", cleanupAuthorized: false, productionTransfer: "not-run", providerCalls: false };
  output(result); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runOperationsReviewV2(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error instanceof OperationsError ? error.code : "OPERATION_STOPPED", message: error instanceof OperationsError ? error.message : "The offline source review could not complete." })); process.exitCode = 1; }
}
