import "server-only";
// THE ONE PLACE the Teams Graph write client and the Teams message writer are built (T-286, T-287; rule 5). Imported by `../write/index.ts` only (the connectors write subpath, which
// the lint rule allows packages/modules/approvals to import and nothing else); `createTeamsWriteClient` and `teamsMessageWriter` are restricted names whose only allowed non-test site is this file
// (packages/eslint-plugin/src/config.js), and write-boundary.test.ts proves the same from the source. It shares the guard, token manager and error sink of the read client (./wiring.ts).
// Never called by a route, page, job or tool: the approvals executor calls `executeWrite` after a person's approval of the exact payload and a single execution claim.
import { actionClaimReader } from "../vault/index";
import { errors, guard, teamsApi, tokens } from "./wiring";
import { createTeamsMessageWriter, type TeamsMessageReconciler } from "./writer";
import { createTeamsWriteClient } from "./write-client";

/** Posts an approved Teams message once (chat send, channel post, channel reply), reads it back and looks it up after an unknown outcome. Approvals only, via the write subpath. */
export const teamsMessageWriter = createTeamsMessageWriter({
  guard,
  api: teamsApi,
  write: createTeamsWriteClient({ guard, tokens, errors }),
  claims: actionClaimReader,
});
/** Recovery (T-192): the writer's read side only (lookup and read-back). It has no `executeWrite`, so a reconciler cannot send. */
export const teamsMessageReconciler: TeamsMessageReconciler = Object.freeze({ findWrite: teamsMessageWriter.findWrite, verifyWrite: teamsMessageWriter.verifyWrite });
