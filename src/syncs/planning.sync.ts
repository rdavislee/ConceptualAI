import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, Sessioning } from "@concepts";
import { freshID } from "@utils/database.ts";

export const CreateProject: Sync = ({ name, description, token, userId, projectId }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "POST", name, description, accessToken: token },
    {},
  ]),
  where: async (frames) => {
    // Check if user is authenticated
    frames = await frames.query(Sessioning._getSession, { token }, { userId });
    
    // Bind a fresh project ID
    return frames.map(f => ({ ...f, projectId: freshID() }));
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
        [Planning.initiate, { status: "needs_clarification", project: projectId, questions }, {}],
        // AND match the original request that started this flow (by causality/same trace)
        // The engine matches these if they are in the same execution trace.
        [Requesting.request, { path: "/projects" }, { request }]
    ),
    then: actions(
        [ProjectLedger.updateStatus, { project: projectId, status: "awaiting_clarification" }],
        [Requesting.respond, { request, status: "awaiting_input", questions }],
    )
});

// REMOVED DUPLICATE DEFINITION

export const PlanningComplete: Sync = ({ projectId, plan, request }) => ({
  when: actions(
    [Planning.initiate, { status: "complete", project: projectId, plan }, {}],
    [Requesting.request, { path: "/projects" }, { request }] 
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
    // ConceptDesigning is not implemented yet, so we just log or respond
    // For now, let's respond to the user that planning is done
    [Requesting.respond, { request, status: "planning_complete", plan }]
  ),
});

export const UserClarifies: Sync = ({ projectId, answers, token, userId, owner, request }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects/:projectId/clarify", answers, accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Authenticate
    frames = await frames.query(Sessioning._getSession, { token }, { userId });
    
    // Authorization: Check if user owns the project
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    
    return frames.filter(f => f.userId === f.owner);
  },
  then: actions(
    [Planning.clarify, { project: projectId, answers }],
  ),
});

export const ClarificationProcessed: Sync = ({ projectId, plan, request }) => ({
  when: actions(
    [Planning.clarify, { status: "complete", project: projectId, plan }, {}],
    // Match the clarification request
    [Requesting.request, { path: "/projects/:projectId/clarify" }, { request }]
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
    // Again, ConceptDesigning not ready, so just respond
    [Requesting.respond, { request, status: "planning_complete", plan }]
  ),
});

export const ClarificationNeedsMore: Sync = ({ projectId, questions, request }) => ({
    when: actions(
        [Planning.clarify, { status: "needs_clarification", project: projectId, questions }, {}],
        [Requesting.request, { path: "/projects/:projectId/clarify" }, { request }]
    ),
    then: actions(
        [ProjectLedger.updateStatus, { project: projectId, status: "awaiting_clarification" }],
        [Requesting.respond, { request, status: "awaiting_input", questions }]
    )
});

