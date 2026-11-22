// Microsoft Graph change notifications (T-068, T-264): POST /api/webhooks/microsoft. A static route beside the dynamic /api/webhooks/[provider] one (Next picks the static segment).
// Microsoft signs nothing: the validation handshake (a `validationToken` query parameter is echoed as text/plain) and each subscription's `clientState` are the credentials, checked in
// @nichols/connectors/webhooks. No session, no cookies: the proxy does not touch /api/webhooks. The lane is read from the stored subscription, never from the request. Never cached: a
// POST handler that reads the request is always dynamic and runs on Node by default; route segment config is a build error, so none is exported here.
import { receiveMicrosoftNotification } from "@nichols/connectors/webhooks";

export async function POST(request: Request) {
  return receiveMicrosoftNotification(request);
}

// Other methods: Next answers 405 itself (no handler exported); the handler also refuses them.
