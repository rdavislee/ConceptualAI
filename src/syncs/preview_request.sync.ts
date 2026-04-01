import { actions, Frames, Sync } from "@engine";
import {
  Assembling,
  CredentialVault,
  FrontendGenerating,
  Previewing,
  ProjectLedger,
  Requesting,
  Sessioning,
} from "@concepts";

const PREVIEW_TRIGGER_PATH = /^\/projects\/([^\/]+)\/preview$/;
const PREVIEW_TEARDOWN_PATH = /^\/projects\/([^\/]+)\/preview\/teardown$/;
const ALLOWED_PREVIEW_STATUSES = new Set(["assembled", "complete"]);
const ACTIVE_PREVIEW_STATUSES = new Set(["processing", "ready", "stopping"]);

function previewsEnabled(): boolean {
  const raw = (Deno.env.get("PREVIEWS_ENABLED") || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function maxActivePerUser(): number {
  const raw = Deno.env.get("PREVIEW_MAX_ACTIVE_PER_USER");
  const parsed = Number.parseInt(raw || "1", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

/**
 * 503 when preview routes are disabled by feature flag.
 */
export const PreviewRoutesDisabled: Sync = ({ request, path, method }) => ({
  when: actions([Requesting.request, { path, method }, { request }]),
  where: async (frames) => {
    if (previewsEnabled()) return frames.filter(() => false);
    return frames.filter((f) => {
      const m = (f[method] as string) || "";
      const p = (f[path] as string) || "";
      if (m === "POST" && PREVIEW_TRIGGER_PATH.test(p)) return true;
      if (m === "POST" && PREVIEW_TEARDOWN_PATH.test(p)) return true;
      return false;
    });
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
 * POST /projects/:projectId/preview
 */
export const TriggerPreview: Sync = (
  {
    request,
    path,
    token,
    userId,
    projectId,
    projectDoc,
    owner,
    activeCount,
    previewDoc,
    geminiUnwrapKey,
    geminiKey,
    geminiTier,
  },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token, geminiUnwrapKey },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);

    frames = frames.map((f) => {
      const match = ((f[path] as string) || "").match(PREVIEW_TRIGGER_PATH);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(
      CredentialVault._resolveCredential,
      { user: userId, provider: "gemini", unwrapKey: geminiUnwrapKey },
      { geminiKey, geminiTier },
    );
    frames = frames.filter((f) =>
      typeof f[geminiKey] === "string" && typeof f[geminiTier] === "string"
    );

    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project: projectDoc },
    );
    frames = frames.filter((f) => {
      const p = f[projectDoc] as any;
      return p && !p.error && p.owner === f[userId] &&
        ALLOWED_PREVIEW_STATUSES.has(p.status);
    });

    const result = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId] as string;
      const uid = frame[userId] as string;

      const backend = await Assembling._getDownloadUrl({ project: pid } as any);
      if (!backend.downloadUrl) continue;

      const frontendRows = await FrontendGenerating._getJob(
        { project: pid } as any,
      );
      const frontend = frontendRows.length > 0 ? frontendRows[0] as any : null;
      const frontendReady = !!frontend && frontend.status === "complete" &&
        (!!frontend.downloadUrl || !!frontend.zipData);
      if (!frontendReady) continue;

      const activeRows = await Previewing._getActiveByOwner(
        { owner: uid } as any,
      );
      const active = activeRows[0]?.active ?? 0;
      const currentRows = await Previewing._getPreview({ project: pid } as any);
      const current = currentRows.length > 0 ? currentRows[0].preview : null;
      const currentIsActive = current &&
        ACTIVE_PREVIEW_STATUSES.has(current.status as string);

      if (!currentIsActive && active >= maxActivePerUser()) {
        continue;
      }

      result.push({
        ...frame,
        [activeCount]: active,
        [previewDoc]: current,
      });
    }

    return result;
  },
  then: actions(
    [Requesting.respond, { request, project: projectId, status: "previewing" }],
    [Previewing.launch, {
      project: projectId,
      owner: userId,
      geminiKey,
      geminiTier,
    }],
  ),
});

export const PreviewRequestUnwrapErrorResponse: Sync = (
  { request, path, token, userId, geminiUnwrapKey, error, statusCode },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token, geminiUnwrapKey },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);
    frames = frames.filter((f) =>
      PREVIEW_TRIGGER_PATH.test(String(f[path] ?? ""))
    );
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(
      CredentialVault._resolveCredential,
      { user: userId, provider: "gemini", unwrapKey: geminiUnwrapKey },
      { error, statusCode },
    );
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode, error },
  ]),
});

/**
 * 409 for preview route when artifacts/quota are not ready.
 */
export const TriggerPreviewConflict: Sync = (
  {
    request,
    path,
    token,
    userId,
    projectId,
    projectDoc,
    reason,
    geminiUnwrapKey,
    geminiKey,
    geminiTier,
  },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token, geminiUnwrapKey },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);

    frames = frames.map((f) => {
      const match = ((f[path] as string) || "").match(PREVIEW_TRIGGER_PATH);
      return match ? { ...f, [projectId]: match[1] } : null;
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(
      CredentialVault._resolveCredential,
      { user: userId, provider: "gemini", unwrapKey: geminiUnwrapKey },
      { geminiKey, geminiTier },
    );
    frames = frames.filter((f) =>
      typeof f[geminiKey] === "string" && typeof f[geminiTier] === "string"
    );

    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project: projectDoc },
    );
    frames = frames.filter((f) => {
      const p = f[projectDoc] as any;
      return p && !p.error && p.owner === f[userId] &&
        ALLOWED_PREVIEW_STATUSES.has(p.status);
    });

    const out = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId] as string;
      const uid = frame[userId] as string;

      const backend = await Assembling._getDownloadUrl({ project: pid } as any);
      if (!backend.downloadUrl) {
        out.push({
          ...frame,
          [reason]:
            "Backend artifact is not available yet. Run build to completion before previewing.",
        });
        continue;
      }

      const frontendRows = await FrontendGenerating._getJob(
        { project: pid } as any,
      );
      const frontend = frontendRows.length > 0 ? frontendRows[0] as any : null;
      const frontendReady = !!frontend && frontend.status === "complete" &&
        (!!frontend.downloadUrl || !!frontend.zipData);
      if (!frontendReady) {
        out.push({
          ...frame,
          [reason]:
            "Frontend artifact is not available yet. Run build to completion before previewing.",
        });
        continue;
      }

      const activeRows = await Previewing._getActiveByOwner(
        { owner: uid } as any,
      );
      const active = activeRows[0]?.active ?? 0;
      const currentRows = await Previewing._getPreview({ project: pid } as any);
      const current = currentRows.length > 0 ? currentRows[0].preview : null;
      const currentIsActive = current &&
        ACTIVE_PREVIEW_STATUSES.has(current.status as string);
      if (!currentIsActive && active >= maxActivePerUser()) {
        out.push({
          ...frame,
          [reason]:
            `Preview limit reached (${maxActivePerUser()} active preview${
              maxActivePerUser() === 1 ? "" : "s"
            } per user).`,
        });
      }
    }

    return out;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 409, error: reason },
  ]),
});

/**
 * POST /projects/:projectId/preview/teardown
 */
export const TriggerPreviewTeardown: Sync = (
  {
    request,
    path,
    token,
    userId,
    projectId,
    projectDoc,
    stopped,
    error,
    statusCode,
    status,
  },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (!previewsEnabled()) return frames.filter(() => false);

    frames = frames.map((f) => {
      const match = ((f[path] as string) || "").match(PREVIEW_TEARDOWN_PATH);
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

    const out = new Frames();
    for (const frame of frames) {
      const result = await Previewing.beginTeardown({
        project: frame[projectId] as any,
      } as any);
      if ("error" in result) {
        out.push({
          ...frame,
          [stopped]: 0,
          [status]: "preview_stop_failed",
          [statusCode]: 500,
          [error]: result.error,
        });
        continue;
      }
      out.push({
        ...frame,
        [stopped]: result.stopped,
        [status]: result.status,
        [statusCode]: 200,
        [error]: null,
      });
    }
    return out;
  },
  then: actions([
    Requesting.respond,
    { request, project: projectId, status, statusCode, error, stopped },
  ]),
});

export const syncs = [
  PreviewRoutesDisabled,
  TriggerPreview,
  PreviewRequestUnwrapErrorResponse,
  TriggerPreviewConflict,
  TriggerPreviewTeardown,
];
