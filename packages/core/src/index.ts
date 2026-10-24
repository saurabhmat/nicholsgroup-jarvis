// Root is client-safe and pure. NEVER re-export env/server, the lane router or the service client
// from here; they get their own subpaths (e.g. @nichols/core/env/server, @nichols/core/lanes).
export const PACKAGE_ID = "core" as const;
export type { LaneId } from "./lanes/index";
