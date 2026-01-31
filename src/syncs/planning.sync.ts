import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, Sessioning } from "@concepts";
import { freshID } from "@utils/database.ts";

/**
 * CreateProject - Multi-sync pattern for POST /projects
 * 
 * This sync:
 * 1. Matches the request and captures { request }
 * 2. Authenticates user in where clause (QUERY only)
 * 3. Triggers ProjectLedger.create and Planning.initiate in then
 * 
 * Response syncs (PlanningComplete, PlanningNeedsClarification) handle the response.
 */
export const CreateProject: Sync = ({ name, description, token, userId, projectId, request }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "POST", name, description, accessToken: token },
    { request },  // CRITICAL: Must capture request for response syncs
  ]),
  where: async (frames) => {
    // Auth check using QUERY method
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    
    // CRITICAL: Filter out frames where auth failed
    frames = frames.filter(f => f[userId] !== undefined);
    
    // Bind a fresh project ID
    return frames.map(f => ({ ...f, [projectId]: freshID() }));
  },
  then: actions(
    [ProjectLedger.create, { owner: userId, project: projectId, name, description }],
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
export const PlanningComplete: Sync = ({ projectId, plan, request }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status: "complete", plan }],
    // ALWAYS include method in request patterns
    [Requesting.request, { path: "/projects", method: "POST" }, { request }] 
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "planning_complete" }],
    [Requesting.respond, { request, status: "planning_complete", plan }]
  ),
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


