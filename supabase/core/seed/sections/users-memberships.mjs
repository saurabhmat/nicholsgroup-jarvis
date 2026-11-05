// Portal users and lane memberships for the personas (T-012). The outsider gets a core.users row but no membership,
// so every lane must deny it.
import { values } from "../sql.mjs";

/** @param {readonly string[]} items */
const textArray = (items) => (items.length === 0 ? "array[]::text[]" : `array[${values(...items)}]::text[]`);

/** @type {import("./index.mjs").SeedSection} */
export default {
  id: "users-memberships",
  description: "core.users for every persona and core.memberships per persona and lane",
  build(ctx) {
    const { epoch, personas } = ctx.data;
    const out = [];
    for (const p of personas) {
      out.push(
        "insert into core.users (id, display_name, created_at, updated_at) values (" +
          `${values(p.id, p.displayName, epoch, epoch)}) on conflict (id) do nothing;`,
      );
    }
    for (const p of personas) {
      for (const m of p.memberships) {
        out.push(
          "insert into core.memberships (user_id, lane_id, role, views, created_at, updated_at) values (" +
            `${values(p.id, m.lane, m.role)}, ${textArray(m.views)}, ${values(epoch, epoch)}) ` +
            "on conflict (user_id, lane_id) do nothing;",
        );
      }
    }
    return out;
  },
};
