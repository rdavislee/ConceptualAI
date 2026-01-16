import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, UserSessioning } from "@concepts";
import { freshID } from "@utils/database.ts";

export const CreateProject: Sync = ({ name, description, token, userId, projectId }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "POST", name, description, accessToken: token },
    {},
  ]),
  where: async (frames) => {
    // Check if user is authenticated
    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    
    // Bind a fresh project ID
    return frames.map(f => ({ ...f, [projectId]: freshID() }));
  },
  then: actions(
    [ProjectLedger.create, { owner: userId, project: projectId, name, description }],
    [Planning.initiate, { project: projectId, description }],
  ),
});

// We need to redefine the sync to include the Request matching
export const PlanningNeedsClarification: Sync = ({ projectId, questions, request }) => ({
    when: actions(
        // Match the planning result
        [Planning.initiate, { project: projectId }, { status: "needs_clarification", questions }],
        // AND match the original request that started this flow (by causality/same trace)
        // The engine matches these if they are in the same execution trace.
        [Requesting.request, { path: "/projects" }, { request }]
    ),
    then: actions(
        [ProjectLedger.updateStatus, { project: projectId, status: "awaiting_clarification" }],
        [Requesting.respond, { request, status: "awaiting_input", questions }],
    )
});

export const PlanningComplete: Sync = ({ projectId, plan, request }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status: "complete", plan }],
    [Requesting.request, { path: "/projects" }, { request }] 
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "planning_complete" }],
    // Respond to user with plan for confirmation
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
    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    
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
    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    
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


