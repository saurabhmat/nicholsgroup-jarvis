// The Composio route handlers (T-219), built once from the connector's flow, the signed-in user's session guard (owner or
// admin_technical of the lane at aal2: the same as every connect) and the Test check. The route files only call these.
import { composioCheck, composioFlow, createComposioHandlers } from "@nichols/connectors/composio";
import { connectAuthorizer } from "@/lib/connect";

export const composioHandlers = createComposioHandlers({ flow: composioFlow, authorizer: connectAuthorizer, check: composioCheck });
