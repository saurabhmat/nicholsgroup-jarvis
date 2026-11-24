// "Send = your approval" for a Teams chat message (T-288; docs/specs/messages.md 10.3, 22.8; decision D-67): ONE user step that is propose + approve + claim + execute + verify, inline, for the exact text
// the person typed. Rule 5: this is the only way the Messages page reaches the Teams writer, and it does so only through the approvals functions below (the database checks owner, role, AAL2, the
// step-up age, every gate and the single claim again at each step). The caller (the route) has already done: same site, session at AAL2, `requireStepUp` within the lane's Teams window, the module
// visible and the connection named by `conn` being the caller's own usable Teams row. Here, in this order, each refusal with a fixed name and nothing proposed until the last one passes:
//   1 the caller's write role (owner, admin_technical)          -> ApprovalsError("forbidden")
//   2 the connection is the caller's usable Teams connection    -> ApprovalsError("not_found") (the same answer for anything else)
//   3 the gates, by name (`teamsChatSendGate`)                   -> { kind: "gate", gate }
//   4 the text, validated by the connector's Zod schema          -> ApprovalsError("invalid")
//   5 `textSha256` (the browser's hash of the text it shows) equals the server's hash of the same text -> { kind: "text_mismatch" }
//   6 propose (the same client request id is the same action) -> approve the hash just computed -> claim -> ONE POST (no retry) -> read back, as `approveAndExecuteTeams`.
// The text lives only in the one proposal (until a terminal state, when the database empties it) and the one POST body: never in a log, an audit row, an error or an event.
import { createHash, timingSafeEqual } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { TEAMS_SEND_FAILURES } from "@nichols/connectors/write";
import { teamsChatSendGate, type TeamsSendGate } from "./capability";
import type { ApproveResult } from "./email";
import { checkId, checkLane, rejectAction } from "./email";
import { ApprovalsError } from "./errors";
import { approveAndExecuteTeams, buildTeamsSend, proposeTeamsAction, type TeamsExecDeps } from "./teams";
import { WRITE_ROLES, type UserCtx } from "./types";

export type SendTeamsInput = {
  /** The connection the open conversation was read through (the route re-checked it as the caller's own). */
  connectionId: string;
  /** The chat id (decoded and validated by the route from the chat key). */
  chatId: string;
  /** What the person typed (any line-break style; normalised here exactly as the browser normalises before hashing). */
  text: string;
  /** SHA-256 (lower-case hex) of the NORMALISED text, computed by the browser from the text it shows. */
  textSha256: string;
  /** One per composed message (the browser's lower-case UUID): a double click or a repeated request is the same action. */
  clientRequestId: string;
};

export type TeamsSendOutcome =
  | { kind: "gate"; gate: TeamsSendGate }
  | { kind: "text_mismatch" }
  | { kind: "result"; result: ApproveResult };

/** SHA-256 of a normalised text, lower-case hex. The one definition both the browser (Web Crypto) and the server compute. */
export const teamsTextHash = (normalisedText: string): string => createHash("sha256").update(normalisedText, "utf8").digest("hex");

const HEX64 = /^[0-9a-f]{64}$/;
function sameHash(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * A refusal that happened BEFORE any message could have left, said structurally (T-288 review B), not by a string match: `phase: "before"` = nothing was proposed because a read before `proposeTeamsAction` was called failed (the role read, the facts read; a failure INSIDE `proposeTeamsAction` is an unknown outcome, see below); `phase: "rejected"` = it was proposed and then refused before approval, and the proposal was rejected on the spot so its text is gone (`freshId`: a replay of the same
 * request id would find that rejected action, so the person's next press needs a new id). The route answers both as a definite refusal that keeps the person's text.
 */
export class TeamsSendRefusal extends ApprovalsError {
  readonly phase: "before" | "rejected";
  constructor(code: ApprovalsError["code"], phase: "before" | "rejected") {
    super(code);
    this.phase = phase;
  }
  get freshId(): boolean {
    return this.phase === "rejected";
  }
}

export async function sendTeamsMessage(deps: TeamsExecDeps, ctx: UserCtx, input: SendTeamsInput): Promise<TeamsSendOutcome> {
  checkLane(ctx.laneId as LaneId);
  checkId(input.connectionId);
  if (typeof input.text !== "string" || typeof input.textSha256 !== "string") throw new ApprovalsError("invalid");
  // 1: role (the database checks it again at propose). A read that fails here is "nothing sent".
  let role: Awaited<ReturnType<UserCtx["rpc"]>>;
  try {
    role = await ctx.rpc("has_lane_role", { p_uid: ctx.userId, p_lane: ctx.laneId, p_roles: [...WRITE_ROLES["teams.chat.send"]] });
  } catch {
    throw new TeamsSendRefusal("unavailable", "before");
  }
  if (role.error) throw new TeamsSendRefusal("unavailable", "before");
  if (role.data !== true) throw new ApprovalsError("forbidden");
  // 2 and 3: the facts of THIS connection
  let facts: Awaited<ReturnType<TeamsExecDeps["readFacts"]>>;
  try {
    facts = await deps.readFacts(ctx.laneId as LaneId, input.connectionId);
  } catch {
    throw new TeamsSendRefusal("unavailable", "before");
  }
  if (!facts.teams || facts.teams.ownerUserId !== ctx.userId) throw new ApprovalsError("not_found");
  const gate = teamsChatSendGate(facts);
  if (gate !== null) return { kind: "gate", gate };
  // 4: the text and ids, by the connector's own schema (the database says the same in act.teams_shape_ok)
  const place = { type: "teams.chat.send" as const, chatId: input.chatId };
  const send = buildTeamsSend({ place, text: input.text, clientRequestId: input.clientRequestId });
  // 5: the bytes approved are the bytes typed
  if (!sameHash(teamsTextHash(send.text), input.textSha256)) return { kind: "text_mismatch" };
  // 6: propose. The same request id is the same action (a replay finds it, in whatever state it is in). Only a DEFINITE refusal raised before the insert (a gate, the shape check, `request_reused`, a role) is
  // passed on as it is. Anything else that goes wrong INSIDE `proposeTeamsAction` (the insert committed and its answer was lost, the audit write failed after the insert, an odd answer) may have left a
  // proposal behind that a duplicate of this request can approve: an UNKNOWN outcome (a plain `unavailable`, 502), never "before". "Before" is only for the reads above, before it is called.
  let proposed: Awaited<ReturnType<typeof proposeTeamsAction>>;
  try {
    proposed = await proposeTeamsAction(deps, ctx, { connectionId: input.connectionId, place, text: input.text, clientRequestId: input.clientRequestId, aiDrafted: false });
  } catch (e) {
    if (e instanceof ApprovalsError && e.code !== "unavailable") throw e;
    throw new ApprovalsError("unavailable");
  }
  // 7: approve exactly the hash just computed, claim, one POST, read back
  try {
    const result = await approveAndExecuteTeams(deps, ctx, { actionId: proposed.id, hashSeen: proposed.hash });
    return { kind: "result", result };
  } catch (e) {
    // The approve / claim / execute step threw. Say only what is certain (T-288 re-check):
    //  * `expired` (a replay of a proposal that lapsed before it was approved): nothing was sent, and it never will be: a definite "failed / expired".
    //  * D1: refused between propose and approve (the database refuses the step-up, a gate closing at that moment): the proposal still holds the text until it expires. If it is still only `proposed`
    //    (never approved, never claimed), the owner's own reject (approvals only) removes the text now. If that reject fails, the state is read again: only `rejected` or `expired` is a definite refusal;
    //    every other state (even still `proposed`: a duplicate of the same request can still approve it) is an unknown outcome (a plain ApprovalsError, 502), never a "before".
    if (e instanceof ApprovalsError && e.code === "expired") return { kind: "result", result: { status: "failed", actionId: proposed.id, failureCode: "expired" } };
    const code = e instanceof ApprovalsError ? e.code : "unavailable";
    const stateOf = async (): Promise<string | null> => {
      try {
        const job = await deps.jobRpc(ctx.laneId as LaneId);
        const { data, error } = await job("act_action_state", { p_lane: ctx.laneId, p_id: proposed.id });
        const st = !error && Array.isArray(data) ? (data[0] as { status?: unknown } | undefined)?.status : null;
        return typeof st === "string" ? st : null;
      } catch {
        return null;
      }
    };
    const state = await stateOf();
    if (state === "proposed") {
      let rejected = true;
      try {
        await rejectAction(deps, ctx, proposed.id, "The send was refused before it was approved");
      } catch {
        rejected = false;
      }
      if (rejected) throw new TeamsSendRefusal(code, "rejected");
      const after = await stateOf();
      if (after === "rejected" || after === "expired") throw new TeamsSendRefusal(code, "rejected");
      // still proposed (the reject itself failed), approved, executing, verified or unreadable: a duplicate of the same request can still approve and send it, so this is an UNKNOWN outcome (502), never a
      // "before". ("Before" is only for failures that happen before `proposeTeamsAction` was called.) A proposal left behind waits for the one-hour expiry (accepted).
      throw new ApprovalsError("unavailable");
    }
    if (state === "rejected" || state === "expired") throw new TeamsSendRefusal(code, "rejected");
    // approved, executing, verified, failed, unreadable: the error above does not describe what happened to the message
    throw new ApprovalsError("unavailable");
  }
}

/** The fixed sentence for a Teams send failure code (never text from the message or from Microsoft), or null for a code that is not one of them. */
export function teamsSendFailureText(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(TEAMS_SEND_FAILURES, code) ? (TEAMS_SEND_FAILURES as Record<string, string>)[code] ?? null : null;
}
