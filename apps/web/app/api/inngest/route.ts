// Inngest endpoint (T-037): Inngest calls this route to run the app's functions. Signed requests only, except with
// the local Inngest dev server (APP_ENV=local); 503 when jobs are not configured (see @nichols/core/inngest).
import { inngestRoute, platformFunctions } from "@nichols/core/inngest";

export const { GET, POST, PUT } = inngestRoute((inngest) => [...platformFunctions(inngest)]);
