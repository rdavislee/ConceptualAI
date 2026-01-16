import { actions, Sync } from "@engine";
import { Requesting, UserSessioning, ProjectLedger, Planning, ConceptDesigning } from "@concepts";

// GET /projects
export const GetProjects: Sync = ({ request, token, userId, projects }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    frames = await frames.query(ProjectLedger._getProjects, { owner: userId }, { projects });
    return frames.filter(f => f[userId] !== undefined);
  },
  then: actions([
    Requesting.respond, { request, projects }
  ]),
});

// GET /projects/:projectId
export const GetProject: Sync = ({ request, token, userId, projectId, project, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)$/);
        if (match) {
            return { ...f, [projectId]: match[1] };
        }
        return null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    
    // Check ownership
    frames = frames.filter(f => {
        const p = f[project] as any;
        return p && p.owner === f[userId];
    });

    return frames;
  },
  then: actions([
    Requesting.respond, { request, project }
  ]),
});

// GET /projects/:projectId/plan
export const GetPlan: Sync = ({ request, token, userId, projectId, plan, path, projectObj }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/plan$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    
    // Check ownership
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectObj });
    frames = frames.filter(f => (f[projectObj] as any)?.owner === f[userId]);

    frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
    
    // Unwrap the plan object if it's wrapped (depends on query implementation)
    // Planning._getPlan returns [{ plan: PlanDoc }]
    return frames.map(f => {
        const p = f[plan] as any;
        return { ...f, [plan]: p?.plan || p };
    });
  },
  then: actions([
    Requesting.respond, { request, plan }
  ]),
});

// GET /projects/:projectId/design
export const GetDesign: Sync = ({ request, token, userId, projectId, design, path, projectObj }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/design$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(UserSessioning._getUser, { session: token }, { user: userId });
    
    // Check ownership
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectObj });
    frames = frames.filter(f => (f[projectObj] as any)?.owner === f[userId]);

    frames = await frames.query(ConceptDesigning._getDesign, { project: projectId }, { design });
    
    // Unwrap
    return frames.map(f => {
        const d = f[design] as any;
        return { ...f, [design]: d?.design || d };
    });
  },
  then: actions([
    Requesting.respond, { request, design }
  ]),
});
