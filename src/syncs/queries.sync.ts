import { actions, Frames, Sync } from "@engine";
import { Requesting, Sessioning, ProjectLedger, Planning, ConceptDesigning, Implementing } from "@concepts";

// ============================================================================
// GET /projects
// ============================================================================

export const GetProjects: Sync = ({ request, token, userId, projects }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    // Filter only valid sessions
    frames = frames.filter(f => f[userId] !== undefined);
    
    frames = await frames.query(ProjectLedger._getProjects, { owner: userId }, { projects });
    return frames;
  },
  then: actions([
    Requesting.respond, { request, projects }
  ]),
});

export const GetProjectsAuthError: Sync = ({ request, token, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: token }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond, { request, statusCode: 401, error: "Unauthorized" }
  ]),
});

// ============================================================================
// GET /projects/:projectId
// ============================================================================

export const GetProject: Sync = ({ request, token, userId, projectId, project, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse Path
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(/^\/projects\/([^\/]+)$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    // Get Project & Authorize
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    frames = frames.filter(f => {
        const p = f[project] as any;
        return p && !p.error && p.owner === f[userId];
    });

    return frames;
  },
  then: actions([
    Requesting.respond, { request, project }
  ]),
});

// Error Handlers for GetProject

export const GetProjectAuthError: Sync = ({ request, token, error, path }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    if (!(frames[0][path] as string).match(/^\/projects\/([^\/]+)$/)) return frames.filter(() => false);
    frames = await frames.query(Sessioning._getUser, { session: token }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, statusCode: 401, error: "Unauthorized" }]),
});

export const GetProjectNotFound: Sync = ({ request, token, userId, projectId, path, error }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, statusCode: 404, error: "Project not found" }]),
});

export const GetProjectAccessDenied: Sync = ({ request, token, userId, projectId, path, project }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    // Check if project exists BUT owner mismatch
    return frames.filter(f => {
        const p = f[project] as any;
        return p && !p.error && p.owner !== f[userId];
    });
  },
  then: actions([Requesting.respond, { request, statusCode: 403, error: "Access denied" }]),
});


// ============================================================================
// GET /projects/:projectId/plan
// ============================================================================

export const GetPlan: Sync = ({ request, token, userId, projectId, plan, path, projectObj }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)\/plan$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);
    
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectObj });
    frames = frames.filter(f => {
        const p = f[projectObj] as any;
        return p && !p.error && p.owner === f[userId];
    });

    const result = new Frames();
    for (const f of frames) {
      const p = f[projectObj] as any;
      if (p.status === "planning") {
        result.push({ ...f, [plan]: { status: "planning" } });
        continue;
      }
      if (p.status === "awaiting_clarification") {
        const planRows = await Planning._getPlan({ project: f[projectId] as any });
        const planDoc = planRows.length > 0 ? (planRows[0] as any).plan : null;
        result.push({ ...f, [plan]: { status: "awaiting_clarification", questions: planDoc?.questions || [] } });
        continue;
      }
      const planRows = await Planning._getPlan({ project: f[projectId] as any });
      const planDoc = planRows.length > 0 ? (planRows[0] as any).plan : null;
      result.push({ ...f, [plan]: planDoc?.plan || planDoc });
    }
    return result;
  },
  then: actions([
    Requesting.respond, { request, plan }
  ]),
});

// Splitting GetPlan Errors
export const GetPlanAuthError: Sync = ({ request, token, error, path }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    if (!(frames[0][path] as string).match(/^\/projects\/([^\/]+)\/plan$/)) return frames.filter(() => false);
    frames = await frames.query(Sessioning._getUser, { session: token }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, statusCode: 401, error: "Unauthorized" }]),
});

export const GetPlanNotFound: Sync = ({ request, token, userId, projectId, path, error }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)\/plan$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, statusCode: 404, error: "Project not found or access denied" }]),
});

export const GetPlanAccessDenied: Sync = ({ request, token, userId, projectId, path, projectObj }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)\/plan$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { projectObj });
    return frames.filter(f => {
        const p = f[projectObj] as any;
        return p && !p.error && p.owner !== f[userId];
    });
  },
  then: actions([Requesting.respond, { request, statusCode: 403, error: "Project not found or access denied" }]),
});


// ============================================================================
// GET /projects/:projectId/design
// ============================================================================

export const GetDesign: Sync = ({ request, token, userId, projectId, design, path, projectObj }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)\/design$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);
    
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectObj });
    frames = frames.filter(f => {
        const p = f[projectObj] as any;
        return p && !p.error && p.owner === f[userId];
    });

    const result = new Frames();
    for (const f of frames) {
      const p = f[projectObj] as any;
      if (p.status === "designing") {
        result.push({ ...f, [design]: { status: "designing" } });
        continue;
      }
      const designRows = await ConceptDesigning._getDesign({ project: f[projectId] as any });
      const designDoc = designRows.length > 0 ? (designRows[0] as any).design : null;
      result.push({ ...f, [design]: designDoc?.design || designDoc });
    }
    return result;
  },
  then: actions([
    Requesting.respond, { request, design }
  ]),
});

export const GetDesignAuthError: Sync = ({ request, token, error, path }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    if (!(frames[0][path] as string).match(/^\/projects\/([^\/]+)\/design$/)) return frames.filter(() => false);
    frames = await frames.query(Sessioning._getUser, { session: token }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, statusCode: 401, error: "Unauthorized" }]),
});

export const GetDesignNotFound: Sync = ({ request, token, userId, projectId, path, error }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)\/design$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, statusCode: 404, error: "Project not found or access denied" }]),
});

export const GetDesignAccessDenied: Sync = ({ request, token, userId, projectId, path, projectObj }) => ({
  when: actions([Requesting.request, { path, method: "GET", accessToken: token }, { request }]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)\/design$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { projectObj });
    return frames.filter(f => {
        const p = f[projectObj] as any;
        return p && !p.error && p.owner !== f[userId];
    });
  },
  then: actions([Requesting.respond, { request, statusCode: 403, error: "Project not found or access denied" }]),
});

// ============================================================================
// GET /projects/:projectId/implementations
// ============================================================================

export const GetImplementations: Sync = ({ request, token, userId, projectId, implementations, path, projectObj }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)\/implementations$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);
    
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectObj });
    frames = frames.filter(f => {
        const p = f[projectObj] as any;
        return p && !p.error && p.owner === f[userId];
    });

    const result = new Frames();
    for (const f of frames) {
      const p = f[projectObj] as any;
      if (p.status === "implementing") {
        result.push({ ...f, [implementations]: { status: "implementing" } });
        continue;
      }
      const implRows = await Implementing._getImplementations({ project: f[projectId] as any });
      const implData = implRows.length > 0 ? implRows[0] : null;
      const unwrapped = (implData as any)?.implementations || implData;
      result.push({ ...f, [implementations]: unwrapped });
    }
    return result;
  },
  then: actions([
    Requesting.respond, { request, implementations }
  ]),
});
