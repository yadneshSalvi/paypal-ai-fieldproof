import {ensurePublicProject} from "../lib/server/seed";
import {database} from "../lib/server/db";
await ensurePublicProject();
console.log("Fieldproof sample project is persisted. No PayPal payment was created.");
await database().close();
