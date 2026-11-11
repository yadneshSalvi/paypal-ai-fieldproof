import { guardedApi } from "@/lib/server/maintenance";
import { timingSafeEqual } from "node:crypto";
import { processVerifiedWebhooks } from "@/lib/server/webhook-worker";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
async function GETImplementation(request:Request){
 const expected=Buffer.from(`Bearer ${process.env.CRON_SECRET??""}`),supplied=Buffer.from(request.headers.get("authorization")??"");
 if(!process.env.CRON_SECRET||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return Response.json({code:"FORBIDDEN"},{status:403});
 try{return Response.json(await processVerifiedWebhooks(),{headers:{"Cache-Control":"no-store"}});}
 catch{return Response.json({code:"WEBHOOK_WORKER_UNAVAILABLE"},{status:503,headers:{"Cache-Control":"no-store"}});}
}

export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));
