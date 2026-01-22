import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, UserSessioning, ConceptDesigning, Implementing } from "@concepts";

export const TriggerImplementation: Sync = ({ projectId, design, token, userId, owner, request, path, projectDoc }) => ({
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
        const match = p.match(/^\/projects\/([^\/]+)\/implement$/);
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

    // Check Project Status (prevent double implementation)
    // We only allow implementation if status is 'design_complete'
    // This prevents infinite loops if the request isn't consumed immediately
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectDoc });
    frames = frames.filter(f => {
        const p = f[projectDoc] as any;
        return p && p.status === "design_complete";
    });

    // Fetch the Design
    frames = await frames.query(ConceptDesigning._getDesign, { project: projectId }, { design });

    // Verify design exists
    return frames.filter(f => f[design]);
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "implementing" }],
    [Implementing.implementAll, { project: projectId, design }] 
  ),
});

export const ImplementationComplete: Sync = ({ projectId, implementations, request, path }) => ({
  when: actions(
    // The implementing action completes
    [Implementing.implementAll, { project: projectId }, { implementations }],
    // AND we have the original request frame in context
    [Requesting.request, { path }, { request }]
  ),
  where: async (frames) => {
      // Ensure the request path corresponds to this implementation job
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          // IMPORTANT: Check that the request was for implementation
          return p === `/projects/${pid}/implement`;
      });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "implemented" }],
    [Requesting.respond, { request, status: "complete", implementations }]
  )
});

export const syncs = [TriggerImplementation, ImplementationComplete];
