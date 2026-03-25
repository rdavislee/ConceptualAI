import { actions, Frames, Sync } from "@engine";
import {
  Assembling,
  FrontendGenerating,
  GeminiCredentialVault,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
} from "@concepts";

const BUILD_MARKER = "__BUILD__";

export const GetBuildStatusWithUnwrapKey: Sync = (
  {
    projectId,
    token,
    geminiUnwrapKey,
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
    { path, method: "GET", accessToken: token, geminiUnwrapKey },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const p = f[path] as string;
      if (!p) return null;
      const match = p.match(/^\/projects\/([^\/]+)\/(build|assemble)\/status$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[userId] === f[owner]);
    frames = await frames.query(
      GeminiCredentialVault._resolveCredential,
      { user: userId, unwrapKey: geminiUnwrapKey },
      { geminiKey, geminiTier },
    );
    frames = frames.filter((f) => typeof f[geminiKey] === "string");

    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId] as string;
      const ownerId = frame[owner] as string;
      const resolvedGeminiKey = frame[geminiKey] as string;
      const resolvedGeminiTier = frame[geminiTier] as string;

      const assemblyUrl = await Assembling._getDownloadUrl(
        { project: pid } as any,
      );
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

        if (frontendNeedsRetry && !hasActiveSandbox) {
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
          await ProjectLedger.updateStatus({
            project: pid as any,
            status: "building",
          });
          void Sandboxing.provision({
            userId: ownerId as any,
            apiKey: resolvedGeminiKey,
            apiTier: resolvedGeminiTier,
            projectId: pid as any,
            name: projectDoc.name || "Untitled Project",
            description: projectDoc.description || "",
            mode: "syncgenerating",
            feedback: BUILD_MARKER,
            answers: { rollbackStatus: rollback },
            rollbackStatus: rollback,
          }).catch((error) => {
            console.error(
              `[GetBuildStatusWithUnwrapKey] Auto-retry provision failed for project ${pid}:`,
              error,
            );
          });
          frontendRaw = { status: "processing", downloadUrl: null };
        } else if (frontendNeedsRetry && hasActiveSandbox) {
          frontendRaw = { status: "processing", downloadUrl: null };
        }
      }

      const bothComplete = backendRaw.status === "complete" &&
        frontendRaw.status === "complete";
      const backend = bothComplete
        ? backendRaw
        : { status: "processing", downloadUrl: null };
      const frontend = bothComplete
        ? frontendRaw
        : { status: "processing", downloadUrl: null };

      let status = "processing";
      if (bothComplete) {
        status = "complete";
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

export const GetBuildStatusWithUnwrapKeyErrorResponse: Sync = (
  { request, path, token, userId, geminiUnwrapKey, error, statusCode },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token, geminiUnwrapKey },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter((f) =>
      /^\/projects\/[^/]+\/(?:build|assemble)\/status$/.test(String(f[path] ?? ""))
    );
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(
      GeminiCredentialVault._resolveCredential,
      { user: userId, unwrapKey: geminiUnwrapKey },
      { error, statusCode },
    );
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode, error },
  ]),
});
