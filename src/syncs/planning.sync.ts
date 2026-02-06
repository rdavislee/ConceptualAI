import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, Sessioning, Sandboxing } from "@concepts";
import { freshID } from "@utils/database.ts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * SandboxStartup - Triggers planning when the sandbox starts up.
 */
export const SandboxStartup: Sync = ({ projectId, description, name, ownerId }) => ({
  when: actions([
    Sandboxing.start, { projectId, name, description, ownerId }, {}
  ]),
  where: async (frames) => {
    if (!IS_SANDBOX) return [];
    // No more DB lookup needed! Data is passed from Gateway via Env Vars -> start action
    return frames;
  },
  then: actions(
    [Planning.initiate, { project: projectId, description }],
  ),
});

/**
 * CreateProjectAuthError - Handle 401 for POST /projects
 */
export const CreateProjectAuthError: Sync = ({ name, description, token, error, request }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "POST", name, description, accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Check for auth failure
    frames = await frames.query(Sessioning._getUser, { session: token }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

/**
 * PlanningNeedsClarification - Response sync when planning needs user input
 */
export const PlanningNeedsClarification: Sync = ({ projectId, questions, request }) => ({
    when: actions(
        // Match the planning result
        [Planning.initiate, { project: projectId }, { status: "needs_clarification", questions }],
        // Match the original request (same execution trace)
        // ALWAYS include method in request patterns
        [Requesting.request, { path: "/projects", method: "POST" }, { request }]
    ),
    then: actions(
        [ProjectLedger.updateStatus, { project: projectId, status: "awaiting_clarification" }],
        [Requesting.respond, { request, status: "awaiting_input", questions }],
    )
});

/**
 * PlanningComplete - Response sync when planning succeeds
 */
export const PlanningComplete: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status: "complete", plan }],
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "planning_complete" }],
  ),
});

/**
 * SandboxExit - Terminates the sandbox after a result is reached.
 */
export const SandboxExit: Sync = ({ projectId, status }) => ({
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

export const UserModifiesPlan: Sync = ({ projectId, feedback, token, userId, owner, request, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PUT", feedback, accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse path to extract projectId
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/plan$/);
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
    [Planning.modify, { project: projectId, feedback }],
  ),
});

export const PlanModified: Sync = ({ projectId, plan, request, path }) => ({
  when: actions(
    [Planning.modify, { project: projectId }, { status: "complete", plan }],
    // Match the request
    [Requesting.request, { path }, { request }]
  ),
  where: async (frames) => {
      // Ensure the request path matches the project ID
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/plan`;
      });
  },
  then: actions(
    [Requesting.respond, { request, status: "planning_complete", plan }]
  ),
});

export const syncs = [
    SandboxStartup,
    PlanningNeedsClarification,
    PlanningComplete,
    SandboxExit,
    UserClarifies,
    ClarificationProcessed,
    ClarificationNeedsMore,
    UserModifiesPlan,
    PlanModified,
];
