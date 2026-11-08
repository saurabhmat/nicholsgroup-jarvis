// The runtime allow-list (T-219, spec §8.1/§8.4). Our server-side list is the guard, never Composio's own filtering:
// a slug that is not listed for the toolkit is refused here, before the SDK (and so the network) is touched.
import { ConnectorError } from "../contract/errors";
import { ALLOWED_TOOL_SLUGS, isToolkit, type Toolkit } from "./constants";

const SLUG = /^[A-Z][A-Z0-9_]{2,127}$/;

/** Throws `forbidden` unless `slug` is an allow-listed tool of `toolkit`. */
export function assertAllowedSlug(toolkit: string, slug: string): asserts toolkit is Toolkit {
  if (!isToolkit(toolkit) || typeof slug !== "string" || !SLUG.test(slug) || !ALLOWED_TOOL_SLUGS[toolkit].includes(slug)) {
    throw new ConnectorError({ kind: "forbidden", message: "This Composio tool is not on the allow-list" });
  }
}
