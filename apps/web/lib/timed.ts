// T-230 A: the request-scoped timing collector for server components (one per render, via React cache()).
import { cache } from "react";
import { connection } from "next/server";
import { createTimings, timingEnabled } from "./server-timing";

export const requestTimings = cache(() => createTimings());

/** Times one span of server-component work (a loader, a guard). A fixed literal name only: never an id or user data. */
export async function timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  if (!timingEnabled()) return fn();
  // Spans only exist at request time: connection() makes this a dynamic point, so nothing here (a clock, a random id) runs
  // while Next prerenders a static shell. Without it, turning timing on would fail the build ("blocking prerender").
  await connection();
  return requestTimings().time(name, fn);
}
