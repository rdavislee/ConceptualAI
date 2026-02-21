import { actions, Sync } from "@engine";
import { Requesting, Sessioning, ProjectLedger, Planning, ConceptDesigning, Sandboxing } from "@concepts";

// ============================================================================
// DELETE /projects/:projectId
// ============================================================================

export const DeleteProject: Sync = ({ request, token, userId, projectId, path, project }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse Path
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(/^\/projects\/([^\/]+)$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    // 3. Authorize (Check Owner)
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter(f => {
        const p = f[project] as any;
        return p && !p.error && p.owner === f[userId];
    });
  },
  then: actions(
    [Sandboxing.teardownProject, { projectId }],
    [ProjectLedger.delete, { project: projectId }],
    [Planning.delete, { project: projectId }],
    [ConceptDesigning.delete, { project: projectId }],
    [Requesting.respond, { request, status: "deleted" }]
  ),
});

// Error Handling

export const DeleteProjectAuthError: Sync = ({ request, token, error, path }) => ({
  when: actions([Requesting.request, { path, method: "DELETE", accessToken: token }, { request }]),
  where: async (frames) => {
    if (!(frames[0][path] as string).match(/^\/projects\/([^\/]+)$/)) return frames.filter(() => false);
    frames = await frames.query(Sessioning._getUser, { session: token }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, statusCode: 401, error: "Unauthorized" }]),
});

export const DeleteProjectNotFound: Sync = ({ request, token, userId, projectId, path, error }) => ({
  when: actions([Requesting.request, { path, method: "DELETE", accessToken: token }, { request }]),
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

export const DeleteProjectAccessDenied: Sync = ({ request, token, userId, projectId, path, project }) => ({
  when: actions([Requesting.request, { path, method: "DELETE", accessToken: token }, { request }]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(/^\/projects\/([^\/]+)$/);
        return match ? { ...f, [projectId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter(f => {
        const p = f[project] as any;
        return p && !p.error && p.owner !== f[userId];
    });
  },
  then: actions([Requesting.respond, { request, statusCode: 403, error: "Access denied" }]),
});
