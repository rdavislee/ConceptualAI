import { actions, Frames, Sync } from "@engine";
import { Previewing, ProjectLedger, Requesting, Sessioning } from "@concepts";

const PREVIEW_STATUS_PATH = /^\/projects\/([^\/]+)\/preview\/status$/;

function previewsEnabled(): boolean {
  const raw = (Deno.env.get("PREVIEWS_ENABLED") || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export const PreviewStatusDisabled: Sync = ({ request, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET" },
    { request },
  ]),
  where: async (frames) => {
    if (previewsEnabled()) return frames.filter(() => false);
    return frames.filter((f) =>
      PREVIEW_STATUS_PATH.test((f[path] as string) || "")
    );
  },
  then: actions([
    Requesting.respond,
    {
      request,
      statusCode: 503,
      error: "Previews are currently disabled.",
    },
  ]),
});

/**
 * GET /projects/:projectId/preview/status
 */
export const GetPreviewStatus: Sync = (
  {
    request,
    path,
    token,
    userId,
    projectId,
    projectDoc,
    previewDoc,
    payloadStatus,
    payloadError,
    frontendUrl,
    backendUrl,
    expiresAt,
  },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);

    frames = frames.map((f) => {
      const match = ((f[path] as string) || "").match(PREVIEW_STATUS_PATH);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);

    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project: projectDoc },
    );
    frames = frames.filter((f) => {
      const p = f[projectDoc] as any;
      return p && !p.error && p.owner === f[userId];
    });

    await Previewing.reapExpired({} as any);

    const out = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId] as string;
      const rows = await Previewing._getPreview({ project: pid } as any);
      const teardownRows = await Previewing._getTeardownInProgress({
        project: pid,
      } as any);
      const teardownInProgress = teardownRows[0]?.inProgress === true;
      const base = {
        ...frame,
        [payloadError]: null,
        [frontendUrl]: null,
        [backendUrl]: null,
        [expiresAt]: null,
      } as any;
      if (rows.length === 0) {
        out.push({
          ...base,
          [payloadStatus]: "none",
        });
        continue;
      }

      const preview = rows[0].preview as any;
      if (teardownInProgress) {
        out.push({
          ...base,
          [payloadStatus]: "preview_stopping",
        });
        continue;
      }
      if (preview.status === "ready") {
        out.push({
          ...base,
          [payloadStatus]: "ready",
          [payloadError]: null,
          [frontendUrl]: preview.frontendUrl,
          [backendUrl]: preview.backendUrl,
          [expiresAt]: preview.expiresAt,
        });
        continue;
      }
      if (preview.status === "error") {
        out.push({
          ...base,
          [payloadStatus]: "error",
          [payloadError]: preview.lastError || "Preview launch failed.",
        });
        continue;
      }
      if (preview.status === "expired") {
        out.push({
          ...base,
          [payloadStatus]: "expired",
        });
        continue;
      }
      if (preview.status === "stopping") {
        out.push({
          ...base,
          [payloadStatus]: "preview_stopping",
        });
        continue;
      }
      if (preview.status === "stopped") {
        out.push({
          ...base,
          [payloadStatus]: "preview_stopped",
        });
        continue;
      }

      out.push({
        ...base,
        [payloadStatus]: "processing",
      });
    }

    return out;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      status: payloadStatus,
      error: payloadError,
      frontendUrl,
      backendUrl,
      expiresAt,
    },
  ]),
});

export const GetPreviewStatusAuthError: Sync = (
  { request, path, token, error },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);
    frames = frames.filter((f) =>
      PREVIEW_STATUS_PATH.test((f[path] as string) || "")
    );
    if (frames.length === 0) return frames;
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      error,
    });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

export const GetPreviewStatusNotFound: Sync = (
  { request, path, token, userId, projectId, error },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);

    frames = frames.map((f) => {
      const match = ((f[path] as string) || "").match(PREVIEW_STATUS_PATH);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(ProjectLedger._getProject, {
      project: projectId,
    }, {
      error,
    });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Project not found" },
  ]),
});

export const GetPreviewStatusAccessDenied: Sync = (
  { request, path, token, userId, projectId, projectDoc },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);

    frames = frames.map((f) => {
      const match = ((f[path] as string) || "").match(PREVIEW_STATUS_PATH);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project: projectDoc },
    );
    return frames.filter((f) => {
      const p = f[projectDoc] as any;
      return p && !p.error && p.owner !== f[userId];
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Access denied" },
  ]),
});

export const syncs = [
  PreviewStatusDisabled,
  GetPreviewStatus,
  GetPreviewStatusAuthError,
  GetPreviewStatusNotFound,
  GetPreviewStatusAccessDenied,
];
