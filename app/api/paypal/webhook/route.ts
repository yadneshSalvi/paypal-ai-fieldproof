import { guardedApi } from "@/lib/server/maintenance";
import { PaymentError, ProviderError } from "@fracture/paypal-core";
import { DomainError } from "@/lib/domain/money";
import { limitedWebhookBody, receivePayPalWebhook } from "@/lib/server/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function POSTImplementation(request: Request) {
  try {
    const result = await receivePayPalWebhook(await limitedWebhookBody(request), request.headers);
    return Response.json(result, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof DomainError ? error.status : error instanceof PaymentError ? error.httpStatus : 503;
    const code = error instanceof DomainError || error instanceof PaymentError ? error.code : error instanceof ProviderError ? "VERIFICATION_UNAVAILABLE" : "INTAKE_UNAVAILABLE";
    return Response.json({ accepted: false, code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
