import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, Sessioning, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK");

/**
 * SandboxStartup - Triggers planning or modification when the sandbox starts up.
 */
export const SandboxStartup: Sync = ({ projectId, description, name, ownerId }) => ({
  when: actions([
    Sandboxing.startPlanning, { projectId, name, description, ownerId }, {}
  ]),
  where: async (frames) => {
    if (!IS_SANDBOX) return [];
    console.log(`[SandboxStartup] Starting planning sandbox for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    FEEDBACK
      ? [Planning.modify, { project: projectId, feedback: FEEDBACK }]
      : [Planning.initiate, { project: projectId, description }]
  ),
});

/**
 * InitiateComplete - Updates status when initial planning succeeds.
 */
export const InitiateComplete: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status: "complete", plan }],
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "planning_complete" }],
  ),
});

/**
 * ModificationComplete - Updates status when plan modification succeeds.
 */
export const ModificationComplete: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.modify, { project: projectId }, { status: "complete", plan }],
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "planning_complete" }],
  ),
});

/**
 * InitiateNeedsClarification - Handles clarification requests for initial planning.
 */
export const InitiateNeedsClarification: Sync = ({ projectId, questions, request }) => ({
    when: actions(
        [Planning.initiate, { project: projectId }, { status: "needs_clarification", questions }],
        [Requesting.request, { path: "/projects", method: "POST" }, { request }]
    ),
    then: actions(
        [ProjectLedger.updateStatus, { project: projectId, status: "awaiting_clarification" }],
        [Requesting.respond, { request, status: "awaiting_input", questions }],
    )
});

/**
 * SandboxExitInitiate - Terminates sandbox after initial planning reaches a result.
 */
export const SandboxExitInitiate: Sync = ({ projectId, status }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status }],
  ),
  where: async (frames) => {
      if (!IS_SANDBOX) return [];
      return frames.filter(f => {
          const s = f[status] as string;
          return s === "complete" || s === "needs_clarification" || s === "error";
      });
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
});

/**
 * SandboxExitModify - Terminates sandbox after modification reaches a result.
 */
export const SandboxExitModify: Sync = ({ projectId, status }) => ({
  when: actions(
    [Planning.modify, { project: projectId }, { status }],
  ),
  where: async (frames) => {
      if (!IS_SANDBOX) return [];
      return frames.filter(f => {
          const s = f[status] as string;
          return s === "complete" || s === "error";
      });
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
});

export const UserClarifies: Sync = ({ projectId, answers, token, userId, owner, request, path }) => ({
  when: actions([
    Requesting.request,
    { path, answers, accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse path
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/clarify$/);
        if (match) {
            return { ...f, [projectId]: match[1] };
        }
        return null;
    }).filter(f => f !== null) as any;

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });

    // Authorization: Check if user owns the project
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });

    return frames.filter(f => f[userId] === f[owner]);
  },
  then: actions(
    [Planning.clarify, { project: projectId, answers }],
  ),
});

export const ClarificationProcessed: Sync = ({ projectId, plan, request, path }) => ({
  when: actions(
    [Planning.clarify, { project: projectId }, { status: "complete", plan }],
    // Match the clarification request
    [Requesting.request, { path }, { request }]
  ),
  where: async (frames) => {
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/clarify`;
      });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "planning_complete" }],
    // Respond to user with plan for confirmation
    [Requesting.respond, { request, status: "planning_complete", plan }]
  ),
});

export const ClarificationNeedsMore: Sync = ({ projectId, questions, request, path }) => ({
    when: actions(
        [Planning.clarify, { project: projectId }, { status: "needs_clarification", questions }],
        [Requesting.request, { path }, { request }]
    ),
    where: async (frames) => {
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/clarify`;
      });
    },
    then: actions(
        [ProjectLedger.updateStatus, { project: projectId, status: "awaiting_clarification" }],
        [Requesting.respond, { request, status: "awaiting_input", questions }]
    )
});

export const syncs = [
    SandboxStartup,
    InitiateComplete,
    ModificationComplete,
    InitiateNeedsClarification,
    SandboxExitInitiate,
    SandboxExitModify,
    UserClarifies,
    ClarificationProcessed,
    ClarificationNeedsMore,
];
