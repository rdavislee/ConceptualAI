import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, UserSessioning, ConceptDesigning } from "@concepts";

export const TriggerDesign: Sync = ({ projectId, plan, token, userId, owner, request, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse path to extract projectId
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/design$/);
        if (match) {
            return { ...f, [projectId]: match[1] };
        }
        return null;
    }).filter(f => f !== null) as any;

    // Authenticate
    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    
    // Authorization: Check if user owns the project
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    
    // Ensure user owns project
    frames = frames.filter(f => f[userId] === f[owner]);

    // Fetch the Plan
    frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });

    // Verify plan exists and is complete
    return frames.map(f => {
        const pDoc = f[plan] as any;
        if (pDoc && pDoc.status === "complete" && pDoc.plan) {
            // Rebind 'plan' to the inner plan object
            return { ...f, [plan]: pDoc.plan };
        }
        return null; // Filter out
    }).filter(f => f !== null) as any;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
    [ConceptDesigning.design, { project: projectId, plan }] 
  ),
});

export const DesignComplete: Sync = ({ projectId, design, request, path }) => ({
  when: actions(
    [ConceptDesigning.design, { project: projectId }, { design }],
    // Match the request that triggered this
    [Requesting.request, { path }, { request }]
  ),
  where: async (frames) => {
      // Ensure the request path matches the project ID
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/design`;
      });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "design_complete" }],
    [Requesting.respond, { request, status: "complete", design }]
  )
});

export const UserModifiesDesign: Sync = ({ projectId, feedback, token, userId, owner, request, path }) => ({
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
        const match = p.match(/^\/projects\/([^\/]+)\/design$/);
        if (match) {
            return { ...f, [projectId]: match[1] };
        }
        return null;
    }).filter(f => f !== null) as any;

    // Authenticate
    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    
    // Authorization: Check if user owns the project
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    
    // Ensure user owns project
    return frames.filter(f => f[userId] === f[owner]);
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
    [Planning.modify, { project: projectId, feedback }],
  ),
});

export const TriggerDesignModification: Sync = ({ projectId, plan, feedback, request, path }) => ({
    when: actions(
        // Match Planning.modify completion
        [Planning.modify, { project: projectId }, { status: "complete", plan, feedback }],
        // Match the original request context
        [Requesting.request, { path }, { request }]
    ),
    where: async (frames) => {
        // Ensure request path matches '/projects/:id/design'
        return frames.filter(f => {
            const p = f[path] as string;
            const pid = f[projectId] as string;
            return p === `/projects/${pid}/design`;
        });
    },
    then: actions(
        [ConceptDesigning.modify, { project: projectId, plan, feedback }]
    )
});

export const DesignModificationComplete: Sync = ({ projectId, design, request, path }) => ({
  when: actions(
    [ConceptDesigning.modify, { project: projectId }, { design }],
    // Match the request
    [Requesting.request, { path }, { request }]
  ),
  where: async (frames) => {
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/design`;
      });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "design_complete" }],
    [Requesting.respond, { request, status: "complete", design }]
  )
});
