// Persona users in Supabase Auth (local only). No password: `encrypted_password` is empty, so password sign-in always
// fails, and the reserved `example.test` domain cannot receive codes or links outside local Mailpit. Local tests get
// sessions through the admin API or by setting JWT claims in pgTAP. Token columns are '' (not NULL) because GoTrue
// cannot scan NULL into them. No role or lane in metadata: authorization comes from memberships (T-012).
import { json, values } from "../sql.mjs";

/** @type {import("./index.mjs").SeedSection} */
export default {
  id: "auth-personas",
  description: "persona users in auth.users + auth.identities (no password)",
  build(ctx) {
    const { epoch, personas } = ctx.data;
    const out = [];
    for (const p of personas) {
      out.push(
        "insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, " +
          "confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, " +
          "phone_change, phone_change_token, reauthentication_token, raw_app_meta_data, raw_user_meta_data, " +
          "is_super_admin, is_sso_user, is_anonymous, created_at, updated_at) values (" +
          `${values("00000000-0000-0000-0000-000000000000", p.id, "authenticated", "authenticated", p.email, "", epoch, "", "", "", "", "", "", "", "")}, ` +
          `${json({ provider: "email", providers: ["email"] })}, ` +
          `${json({ display_name: p.displayName, synthetic: true })}, ` +
          `${values(false, false, false, epoch, epoch)}) on conflict (id) do nothing;`,
      );
    }
    for (const p of personas) {
      const identityId = ctx.rng.derive(`identity:${p.key}`).uuid();
      out.push(
        "insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at) values (" +
          `${values(identityId, p.id, p.id)}, ` +
          `${json({ sub: p.id, email: p.email, email_verified: true, phone_verified: false })}, ` +
          `${values("email", epoch, epoch)}) on conflict (provider_id, provider) do nothing;`,
      );
    }
    return out;
  },
};
