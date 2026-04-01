import { actions, Frames, Sync } from "@engine";
import {
  Assembling,
  ConceptDesigning,
  FrontendGenerating,
  Implementing,
  Previewing,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
  SyncGenerating,
} from "@concepts";

const REVERT_PATH_REGEX = /^\/projects\/([^\/]+)\/revert$/;
const FIRST_STAGE_STATUSES = new Set([
  "planning",
  "planned",
  "awaiting_input",
  "awaiting_clarification",
]);
const DESIGN_STATUSES = new Set(["designing", "design_complete"]);
const IMPLEMENTING_STATUSES = new Set(["implementing", "implemented"]);
const SYNC_STATUSES = new Set(["sync_generating", "syncs_generated"]);
const BUILD_STATUSES = new Set(["assembling", "building", "assembled", "complete"]);

async function filterPendingRevertRequests(frames: any, request: symbol, projectId: symbol) {
  const pendingFrames = new Frames();
  for (const frame of frames) {
    const pid = frame[projectId] as string;
    const req = frame[request] as string;
    const matches = await Requesting._getPendingRequestsByPaths({
      paths: [`/projects/${pid}/revert`],
      method: "POST",
    } as any);
    if (matches.some((m) => m.request === req)) {
      pendingFrames.push(frame as any);
    }
  }
  return pendingFrames;
}

export const RevertProjectToPlanning: Sync = (
  { request, token, userId, projectId, path, project },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && DESIGN_STATUSES.has(p.status);
    });
  },
  then: actions([Sandboxing.teardownProject, { projectId }]),
});

export const RevertProjectToDesignComplete: Sync = (
  { request, token, userId, projectId, path, project },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && IMPLEMENTING_STATUSES.has(p.status);
    });
  },
  then: actions([Sandboxing.teardownProject, { projectId }]),
});

export const RevertProjectToImplemented: Sync = (
  { request, token, userId, projectId, path, project },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && SYNC_STATUSES.has(p.status);
    });
  },
  then: actions([Sandboxing.teardownProject, { projectId }]),
});

export const RevertProjectToSyncsGenerated: Sync = (
  { request, token, userId, projectId, path, project },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && BUILD_STATUSES.has(p.status);
    });
  },
  then: actions([Sandboxing.teardownProject, { projectId }]),
});

export const CompleteRevertProjectToPlanning: Sync = (
  { request, token, userId, projectId, path, project, terminated },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST", accessToken: token }, { request }],
    [Sandboxing.teardownProject, { projectId }, { terminated }],
  ),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && DESIGN_STATUSES.has(p.status);
    });
  },
  then: actions(
    [ConceptDesigning.delete, { project: projectId }],
    [Requesting.respond, { request, project: projectId, status: "planning_complete", revertedFrom: project }],
    [ProjectLedger.updateStatus, { project: projectId, status: "planning_complete" }],
  ),
});

export const CompleteRevertProjectToDesignComplete: Sync = (
  { request, token, userId, projectId, path, project, terminated },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST", accessToken: token }, { request }],
    [Sandboxing.teardownProject, { projectId }, { terminated }],
  ),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && IMPLEMENTING_STATUSES.has(p.status);
    });
  },
  then: actions(
    [Implementing.deleteProject, { project: projectId }],
    [Requesting.respond, { request, project: projectId, status: "design_complete", revertedFrom: project }],
    [ProjectLedger.updateStatus, { project: projectId, status: "design_complete" }],
  ),
});

export const CompleteRevertProjectToImplemented: Sync = (
  { request, token, userId, projectId, path, project, terminated },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST", accessToken: token }, { request }],
    [Sandboxing.teardownProject, { projectId }, { terminated }],
  ),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && SYNC_STATUSES.has(p.status);
    });
  },
  then: actions(
    [SyncGenerating.deleteProject, { project: projectId }],
    [Requesting.respond, { request, project: projectId, status: "implemented", revertedFrom: project }],
    [ProjectLedger.updateStatus, { project: projectId, status: "implemented" }],
  ),
});

export const CompleteRevertProjectToSyncsGenerated: Sync = (
  { request, token, userId, projectId, path, project, terminated },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST", accessToken: token }, { request }],
    [Sandboxing.teardownProject, { projectId }, { terminated }],
  ),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && BUILD_STATUSES.has(p.status);
    });
  },
  then: actions(
    [FrontendGenerating.deleteProject, { project: projectId }],
    [Assembling.deleteProject, { project: projectId }],
    [Previewing.deleteProject, { project: projectId }],
    [Requesting.respond, { request, project: projectId, status: "syncs_generated", revertedFrom: project }],
    [ProjectLedger.updateStatus, { project: projectId, status: "syncs_generated" }],
  ),
});

export const RevertProjectTeardownFailed: Sync = (
  { request, projectId, path, error },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.teardownProject, { projectId }, { error }],
  ),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    return await filterPendingRevertRequests(frames, request, projectId);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 409, error },
  ]),
});

export const RevertProjectFirstStageBlocked: Sync = (
  { request, token, userId, projectId, path, project },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner === f[userId] && FIRST_STAGE_STATUSES.has(p.status);
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 409, error: "Cannot revert from planning/planned stages." },
  ]),
});

export const RevertProjectUnsupportedStatus: Sync = (
  { request, token, userId, projectId, path, project },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      if (!p || p.error || p.owner !== f[userId]) return false;
      return !FIRST_STAGE_STATUSES.has(p.status) && !DESIGN_STATUSES.has(p.status) &&
        !IMPLEMENTING_STATUSES.has(p.status) && !SYNC_STATUSES.has(p.status) &&
        !BUILD_STATUSES.has(p.status);
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 400, error: "Project is in a status that cannot be reverted." },
  ]),
});

export const RevertProjectAuthError: Sync = (
  { request, token, error, path, projectId },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (!(frames[0][path] as string).match(REVERT_PATH_REGEX)) {
      return frames.filter(() => false);
    }
    frames = await filterPendingRevertRequests(frames, request, projectId);
    frames = await frames.query(Sessioning._getUser, { session: token }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

export const RevertProjectNotFound: Sync = (
  { request, token, userId, projectId, path, error },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Project not found" },
  ]),
});

export const RevertProjectAccessDenied: Sync = (
  { request, token, userId, projectId, path, project },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(REVERT_PATH_REGEX);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    frames = await filterPendingRevertRequests(frames, request, projectId);

    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project });
    return frames.filter((f) => {
      const p = f[project] as any;
      return p && !p.error && p.owner !== f[userId];
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Access denied" },
  ]),
});

export const syncs = [
  RevertProjectToPlanning,
  RevertProjectToDesignComplete,
  RevertProjectToImplemented,
  RevertProjectToSyncsGenerated,
  CompleteRevertProjectToPlanning,
  CompleteRevertProjectToDesignComplete,
  CompleteRevertProjectToImplemented,
  CompleteRevertProjectToSyncsGenerated,
  RevertProjectTeardownFailed,
  RevertProjectFirstStageBlocked,
  RevertProjectUnsupportedStatus,
  RevertProjectAuthError,
  RevertProjectNotFound,
  RevertProjectAccessDenied,
];
