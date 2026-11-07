# Brain templates (seed files)

Seed documents the app creates for a new user (in the user's home lane: `P` once enabled, otherwise the enabled lane chosen in setup, PKG in the pilot) or a new lane. Adapted from the AI Employee Course brain structure for Jarvis. **No real data here** (CLAUDE.md rule 10). Moved here from `docs/brain-templates/` by T-210.

How they are used (`packages/modules/brain`):
- `scripts/build-templates.mjs` bundles these files into `src/domain/templates.generated.ts` (run `node packages/modules/brain/scripts/build-templates.mjs` after editing a file here; a unit test fails when the generated file is out of date). The README is not bundled.
- The server creates each missing page on first use through `brain.document_save` (`if_version = 0`, so the seed is version 1 and appears in the page's history), and each missing skill through `brain.skill_save`. Never through a migration; the local seed uses synthetic lanes only.
- No `Context/Work.md` is created for NL until the NL data plane exists (the lane router refuses the lane, so the seeding never reaches it).

| Path | Seeded for | Filled by |
|---|---|---|
| `AGENTS.md` | system (static prompt section, not a user doc; used by T-212) | — |
| `Context/About-Me.md` | each user, home lane | interview Part A |
| `Context/Preferences.md` | each user, home lane | interview A8 – A10 |
| `Context/Work.md` | each lane | interview A5 – A6 |
| `Employees/Personal-Assistant.md` | per employee (instructions text; T-211 creates the profile) | interview Part B |
| `Projects/_template/BRIEF.md`, `HANDOFF.md` | on "New project" | user / project-handoff skill |
| `Skills/*/SKILL.md` | system skills (`brain.skills`) | — |

"Not provided" means unknown. The assistant must never treat it as a fact or replace it with a guess.
