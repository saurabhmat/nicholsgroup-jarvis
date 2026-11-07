# Brain templates (seed files)

Seed documents the app creates for a new user (in the user's home lane: `P` once enabled, otherwise the enabled lane chosen in setup, PKG in the pilot) or a new lane. Adapted from the AI Employee Course brain structure for Jarvis. **No real data here** (CLAUDE.md rule 10). T-210 moves these into `packages/modules/brain/templates/` and creates them lazily on first use as `brain.documents` rows with `version = 0` (never through a migration; the local seed uses synthetic lanes only). No `Context/Work.md` is created for NL until the NL data plane exists.

| Path | Seeded for | Filled by |
|---|---|---|
| `AGENTS.md` | system (static prompt section, not a user doc) | — |
| `Context/About-Me.md` | each user, home lane | interview Part A |
| `Context/Preferences.md` | each user, home lane | interview A8 – A10 |
| `Context/Work.md` | each lane | interview A5 – A6 |
| `Employees/Personal-Assistant.md` | per employee | interview Part B |
| `Projects/_template/BRIEF.md`, `HANDOFF.md` | on "New project" | user / project-handoff skill |
| `Skills/*/SKILL.md` | system skills | — |

"Not provided" means unknown. The assistant must never treat it as a fact or replace it with a guess.
