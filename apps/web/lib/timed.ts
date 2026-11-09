// T-230 A: the request-scoped timing collector for server components (one per render, via React cache()).
import { cache } from "react";
import { createTimings } from "./server-timing";

export const requestTimings = cache(() => createTimings());

/** Times one span of server-component work (a loader, a guard). A fixed literal name only: never an id or user data. */
export const timed = <T>(name: string, fn: () => Promise<T> | T): Promise<T> => requestTimings().time(name, fn);
