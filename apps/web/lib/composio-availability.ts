// Which Composio toolkits can be connected on this server (T-219): booleans only, from the connector's configuration read
// (COMPOSIO_API_KEY and the toolkit's auth config id). Values never leave the connector.
import { composioAvailability, composioMissingSettings } from "@nichols/connectors/composio";
import type { Availability, MissingSettings } from "@/lib/composio-connection";

export function availability(): Availability {
  return composioAvailability();
}

/** The NAMES of the settings a toolkit is missing (never values), for "Not configured: … is not set". */
export function missingSettings(): MissingSettings {
  return composioMissingSettings();
}
