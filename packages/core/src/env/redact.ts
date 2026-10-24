// Defence in depth for env objects: console.log / util.inspect / JSON.stringify of an env object print
// "[redacted]" for secret-like fields. (Spreading or reading a property still yields the real value: callers
// who need a secret must ask for it explicitly.)
import { isSecretLikeName, isSecretLikeValue } from "./secret-patterns";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const REDACTED = "[redacted]";

export function withRedaction<T extends object>(target: T): T {
  const view = (): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(target).map(([key, value]) => [
        key,
        isSecretLikeName(key) || (typeof value === "string" && isSecretLikeValue(value)) ? REDACTED : value,
      ]),
    );
  Object.defineProperty(target, "toJSON", { value: view, enumerable: false });
  Object.defineProperty(target, INSPECT, { value: view, enumerable: false });
  return target;
}
