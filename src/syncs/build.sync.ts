import { actions, Frames, Sync } from "@engine";
import {
  Assembling,
  FrontendGenerating,
  Implementing,
  Planning,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
  SyncGenerating,
} from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const SANDBOX_FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK") || "";
const BUILD_MARKER = "__BUILD__";
const FALLBACK_API_DEFINITION = {
  format: "openapi",
  encoding: "yaml",
  content:
    "openapi: 3.0.0\ninfo:\n  title: Generated API\n  version: 1.0.0\npaths: {}\n",
};
/**
 * BuildSandboxStartup - Sandbox side.
 * Runs backend assembly and frontend generation together in one sandbox.
 */
export const BuildSandboxStartup: Sync = (
  {
    projectId,
    plan,
    implementations,
    syncs,
    apiDefinition,
    frontendGuide,
    feedback,
    rollbackStatus,
  },
) => {
  return {
    when: actions([
      Sandboxing.startSyncGenerating,
      { projectId, feedback, rollbackStatus },
      {},
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      frames = frames.filter((f) => {
        const actionFeedback = String(f[feedback] ?? "");
        if (actionFeedback.startsWith(BUILD_MARKER)) return true;
        if (actionFeedback.length > 0) return false;
        return SANDBOX_FEEDBACK.startsWith(BUILD_MARKER);
      });
      if (frames.length === 0) return frames;

      const hydrated = new Frames();
      for (const frame of frames) {
        const pid = frame[projectId] as string;

        // Load artifacts directly so we can keep this flow resilient to partial
        // records and still run/retry inside one sandbox session.
        const planRows = await Planning._getPlan({ project: pid } as any);
        const planDoc = (planRows[0] as any)?.plan;
        const planValue = planDoc?.plan ?? {};

        const implRows = await Implementing._getImplementations(
          { project: pid } as any,
        );
        const implementationsValue = (implRows[0] as any)?.implementations ??
          {};

        const syncRows = await SyncGenerating._getSyncs(
          { project: pid } as any,
        );
        const syncDoc = syncRows.length > 0 ? (syncRows[0] as any) : null;
        const syncList = Array.isArray(syncDoc?.syncs) ? syncDoc.syncs : [];
        const endpointBundles = Array.isArray(syncDoc?.endpointBundles)
          ? syncDoc.endpointBundles
          : [];
        const apiDefValue = syncDoc?.apiDefinition ?? FALLBACK_API_DEFINITION;
        const guideValue = typeof syncDoc?.frontendGuide === "string"
          ? syncDoc.frontendGuide
          : "";

        hydrated.push({
          ...frame,
          [plan]: planValue,
          [implementations]: implementationsValue,
          [syncs]: {
            syncs: syncList,
            apiDefinition: apiDefValue,
            endpointBundles,
          },
          [apiDefinition]: apiDefValue,
          [frontendGuide]: guideValue,
        });
      }

      return hydrated;
    },
    then: actions(
      [ProjectLedger.updateAutocomplete, {
        project: projectId,
        autocomplete: false,
      }],
      [Assembling.assemble, {
        project: projectId,
        plan,
        implementations,
        syncs,
      }],
      [FrontendGenerating.generate, {
        project: projectId,
        plan,
        apiDefinition,
        frontendGuide,
      }],
    ),
  };
};

export const BuildSandboxComplete: Sync = (
  { projectId, backendDownloadUrl, frontendDownloadUrl, feedback, rollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startSyncGenerating, { projectId, feedback, rollbackStatus }, {}],
    [Assembling.assemble, { project: projectId }, {
      downloadUrl: backendDownloadUrl,
    }],
    [FrontendGenerating.generate, { project: projectId }, {
      status: "complete",
      downloadUrl: frontendDownloadUrl,
    }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const actionFeedback = String(f[feedback] ?? "");
      if (actionFeedback.startsWith(BUILD_MARKER)) return true;
      if (actionFeedback.length > 0) return false;
      return SANDBOX_FEEDBACK.startsWith(BUILD_MARKER);
    });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "assembled" }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  ),
});

export const BuildSandboxBackendError: Sync = (
  { projectId, error, feedback, rollbackStatus, effectiveRollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startSyncGenerating, { projectId, feedback, rollbackStatus }, {}],
    [Assembling.assemble, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames.map((f) => ({
      ...f,
      [effectiveRollbackStatus]:
        typeof f[rollbackStatus] === "string" && String(f[rollbackStatus]).length > 0
          ? f[rollbackStatus]
          : "syncs_generated",
    })).filter((f) => {
      const actionFeedback = String(f[feedback] ?? "");
      if (actionFeedback.startsWith(BUILD_MARKER)) return true;
      if (actionFeedback.length > 0) return false;
      return SANDBOX_FEEDBACK.startsWith(BUILD_MARKER);
    }) as any;
  },
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: effectiveRollbackStatus,
    }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  ),
});

export const BuildSandboxFrontendError: Sync = (
  { projectId, error, feedback, rollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startSyncGenerating, { projectId, feedback, rollbackStatus }, {}],
    [FrontendGenerating.generate, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const actionFeedback = String(f[feedback] ?? "");
      if (actionFeedback.startsWith(BUILD_MARKER)) return true;
      if (actionFeedback.length > 0) return false;
      return SANDBOX_FEEDBACK.startsWith(BUILD_MARKER);
    });
  },
  then: actions(
    [Assembling.deleteProject, { project: projectId }],
    [FrontendGenerating.deleteProject, { project: projectId }],
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "syncs_generated",
    }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  ),
});

/**
 * GET /projects/:projectId/build/status
 * Also handles /projects/:projectId/assemble/status for backwards compatibility
 *
 * Returns the combined status of both backend and frontend generation.
 * Updates project status to "assembled" when BOTH are complete.
 */
export const GetBuildStatus: Sync = (
  {
    projectId,
    token,
    userId,
    owner,
    request,
    path,
    backendStatus,
    frontendStatus,
    overallStatus,
    geminiKey,
    geminiTier,
  },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token, geminiKey, geminiTier },
    { request },
  ]),
  where: async (frames) => {
    console.log(
      "[GetBuildStatus] Starting where clause, frames:",
      frames.length,
    );

    // Parse path - accepts both /build/status and /assemble/status
    frames = frames.map((f) => {
      const p = f[path] as string;
      if (!p) return null;
      // Match /projects/{id}/build/status OR /projects/{id}/assemble/status
      const match = p.match(/^\/projects\/([^\/]+)\/(build|assemble)\/status$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter((f) => f !== null) as any;
    console.log("[GetBuildStatus] After path parse, frames:", frames.length);

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    console.log("[GetBuildStatus] After auth, frames:", frames.length);

    // Authorization
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[userId] === f[owner]);
    console.log("[GetBuildStatus] After owner check, frames:", frames.length);

    // Get backend and frontend status
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId] as string;
      const ownerId = frame[owner] as string;
      const requestGeminiKey = (frame[geminiKey] as string) || "";
      const requestGeminiTier = (frame[geminiTier] as string) || "";
      const hasRetryCredentials = requestGeminiKey.trim().length > 0 &&
        (requestGeminiTier === "1" || requestGeminiTier === "2" ||
          requestGeminiTier === "3");

      // Get Assembling status
      const assemblyUrl = await Assembling._getDownloadUrl(
        { project: pid } as any,
      );

      // Get FrontendGenerating status
      const frontendJobs = await FrontendGenerating._getJob(
        { project: pid } as any,
      );
      const frontendJob = frontendJobs.length > 0 ? frontendJobs[0] : null;
      const projectRows = await ProjectLedger._getProject(
        { project: pid } as any,
      );
      const projectDoc = projectRows.length > 0
        ? (projectRows[0] as any).project
        : null;

      const backendRaw = assemblyUrl.downloadUrl
        ? { status: "complete", downloadUrl: assemblyUrl.downloadUrl }
        : { status: "processing" };

      let frontendRaw = frontendJob
        ? {
          status: frontendJob.status,
          downloadUrl: frontendJob.downloadUrl || null,
        }
        : { status: "processing" };

      // Auto-heal path: if backend already exists but frontend is missing/failed/stuck,
      // start a new sandboxed build retry so frontend generation can recover.
      const projectAllowsRetry = projectDoc && (
        projectDoc.status === "building" ||
        projectDoc.status === "assembled" ||
        projectDoc.status === "complete"
      );
      if (backendRaw.status === "complete" && projectAllowsRetry) {
        const activeRows = await Sandboxing._isActive(
          { userId: ownerId as any } as any,
        );
        const hasActiveSandbox = activeRows.length > 0 &&
          !!activeRows[0].active;
        const frontendMissing = !frontendJob;
        const frontendFailed = frontendRaw.status === "error";
        const frontendStuckProcessing = !!frontendJob &&
          frontendRaw.status === "processing" && !hasActiveSandbox;
        const frontendNeedsRetry = frontendMissing || frontendFailed ||
          frontendStuckProcessing;

        if (frontendNeedsRetry && !hasActiveSandbox && hasRetryCredentials) {
          if (frontendStuckProcessing) {
            await FrontendGenerating.jobs.updateOne(
              { _id: pid as any },
              {
                $set: { status: "error", updatedAt: new Date() },
                $push: {
                  logs:
                    "Detected processing frontend job without active sandbox; resetting for auto-retry.",
                },
              } as any,
            );
          }

          const rollback = projectDoc.status || "assembled";
          console.log(
            `[GetBuildStatus] Auto-retrying frontend build in sandbox for project ${pid} (backend already complete, frontend missing/failed/stuck).`,
          );
          await ProjectLedger.updateStatus({
            project: pid as any,
            status: "building",
          });
          void Sandboxing.provision({
            userId: ownerId as any,
            apiKey: requestGeminiKey,
            apiTier: requestGeminiTier,
            projectId: pid as any,
            name: projectDoc.name || "Untitled Project",
            description: projectDoc.description || "",
            mode: "syncgenerating",
            feedback: BUILD_MARKER,
            answers: { rollbackStatus: rollback },
            rollbackStatus: rollback,
          }).catch((error) => {
            console.error(
              `[GetBuildStatus] Auto-retry provision failed for project ${pid}:`,
              error,
            );
          });
          frontendRaw = { status: "processing", downloadUrl: null };
        } else if (frontendNeedsRetry && hasActiveSandbox) {
          // Avoid surfacing stale "error" while an active retry sandbox is running.
          frontendRaw = { status: "processing", downloadUrl: null };
        }
      }

      // Return backend/frontend atomically: URLs are only visible when BOTH are complete.
      const bothComplete = backendRaw.status === "complete" &&
        frontendRaw.status === "complete";
      const backend = bothComplete
        ? backendRaw
        : { status: "processing", downloadUrl: null };
      const frontend = bothComplete
        ? frontendRaw
        : { status: "processing", downloadUrl: null };

      // Determine overall status - only "complete" when BOTH are complete
      let status = "processing";
      if (bothComplete) {
        status = "complete";
        // Update project status to assembled when both complete
        await ProjectLedger.updateStatus({
          project: pid as any,
          status: "assembled",
        });
      } else if (frontendRaw.status === "error") {
        status = "error";
      }

      newFrames.push({
        ...frame,
        [backendStatus]: backend,
        [frontendStatus]: frontend,
        [overallStatus]: status,
      });
    }

    return newFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      status: overallStatus,
      backend: backendStatus,
      frontend: frontendStatus,
    },
  ]),
});


/**
 * GET /downloads/:projectId_backend.zip
 *
 * Downloads the assembled backend project.
 */
export const DownloadBackend: Sync = (
  { projectId, token, userId, owner, request, path, stream },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse path - pattern: /downloads/:projectId_backend.zip
    frames = frames.map((f) => {
      const p = f[path] as string;
      if (!p) return null;
      const match = p.match(/^\/downloads\/([^_]+)_backend\.zip$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter((f) => f !== null) as any;

    // Authenticate & Authorize
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[userId] === f[owner]);

    // Fetch Stream from Assembling
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId];
      const fileStream = await Assembling.getFileStream(
        { project: pid } as any,
      );
      if (fileStream) {
        newFrames.push({ ...frame, [stream]: fileStream });
      }
    }
    return newFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      stream: stream,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="backend.zip"',
      },
    },
  ]),
});

/**
 * GET /downloads/:projectId_frontend.zip
 *
 * Downloads the generated frontend project.
 */
export const DownloadFrontend: Sync = (
  { projectId, token, userId, owner, request, path, stream },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse path - pattern: /downloads/:projectId_frontend.zip
    frames = frames.map((f) => {
      const p = f[path] as string;
      if (!p) return null;
      const match = p.match(/^\/downloads\/([^_]+)_frontend\.zip$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter((f) => f !== null) as any;

    // Authenticate & Authorize
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[userId] === f[owner]);

    // Fetch Stream from FrontendGenerating
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId];
      const fileStream = await FrontendGenerating.getFileStream(
        { project: pid } as any,
      );
      if (fileStream) {
        newFrames.push({ ...frame, [stream]: fileStream });
      }
    }
    return newFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      stream: stream,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="frontend.zip"',
      },
    },
  ]),
});

/**
 * GET /downloads/:projectId.zip
 *
 * Downloads the assembled backend project (generic path for backwards compatibility).
 */
export const DownloadProject: Sync = (
  { projectId, token, userId, owner, request, path, stream },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse path - pattern: /downloads/:projectId.zip (no _backend or _frontend suffix)
    frames = frames.map((f) => {
      const p = f[path] as string;
      if (!p) return null;
      // Match /downloads/{id}.zip but NOT /downloads/{id}_backend.zip or /downloads/{id}_frontend.zip
      const match = p.match(/^\/downloads\/([^_\.]+)\.zip$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter((f) => f !== null) as any;

    // Authenticate & Authorize
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[userId] === f[owner]);

    // Fetch Stream from Assembling (backend)
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId];
      const fileStream = await Assembling.getFileStream(
        { project: pid } as any,
      );
      if (fileStream) {
        newFrames.push({ ...frame, [stream]: fileStream });
      }
    }
    return newFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      stream: stream,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="project.zip"',
      },
    },
  ]),
});

export const syncs = [
  BuildSandboxStartup,
  BuildSandboxComplete,
  BuildSandboxBackendError,
  BuildSandboxFrontendError,
  GetBuildStatus,
  DownloadBackend,
  DownloadFrontend,
  DownloadProject,
];
