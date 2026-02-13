import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sandboxing, Sessioning } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const BUILD_MARKER = "__BUILD__";

/**
 * TriggerBuild - Gateway side.
 * Provisions one sandbox that performs backend assembly and frontend generation.
 */
export const TriggerBuild: Sync = (
  {
    projectId,
    token,
    userId,
    owner,
    request,
    path,
    projectDoc,
    projectName,
    projectDescription,
    geminiKey,
    geminiTier,
    rollbackStatus,
  },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token, geminiKey, geminiTier },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    console.log("[TriggerBuildRequest] starting, frames:", frames.length);

    // Parse /projects/:projectId/build
    frames = frames.map((f) => {
      const p = f[path] as string;
      if (!p) return null;
      const match = p.match(/^\/projects\/([^\/]+)\/build$/);
      if (match) return { ...f, [projectId]: match[1] };
      return null;
    }).filter((f) => f !== null) as any;
    console.log("[TriggerBuildRequest] after path parse:", frames.length);

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    console.log("[TriggerBuildRequest] after auth:", frames.length);

    // Require non-empty credentials and supported tier for sandbox pipeline triggers
    frames = frames.filter((f) => {
      const key = (f[geminiKey] as string) || "";
      const tier = (f[geminiTier] as string) || "";
      return key.trim().length > 0 &&
        (tier === "1" || tier === "2" || tier === "3");
    });

    // Authorization
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[userId] === f[owner]);
    console.log("[TriggerBuildRequest] after owner check:", frames.length);

    // Project status + metadata
    frames = await frames.query(ProjectLedger._getProject, {
      project: projectId,
    }, { project: projectDoc });
    frames = frames.filter((f) => {
      const p = f[projectDoc] as any;
      return p &&
        (p.status === "syncs_generated" || p.status === "building" ||
          p.status === "assembled" || p.status === "complete");
    });
    console.log("[TriggerBuildRequest] after status check:", frames.length);

    // Keep gateway-side checks permissive here so retries can re-enter sandbox
    // even if some intermediate artifacts are partial/stale. Sandbox-side syncs
    // handle the final data loading and failure behavior.
    console.log(
      "[TriggerBuildRequest] skipping strict artifact gating, frames:",
      frames.length,
    );

    const out = frames.map((f) => {
      const p = f[projectDoc] as any;
      return {
        ...f,
        [projectName]: p.name,
        [projectDescription]: p.description,
        [geminiKey]: f[geminiKey],
        [geminiTier]: f[geminiTier],
        [rollbackStatus]: p.status,
      };
    });
    console.log("[TriggerBuildRequest] final frames:", out.length);
    return out;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "building" }],
    [Sandboxing.provision, {
      userId,
      apiKey: geminiKey,
      apiTier: geminiTier,
      projectId,
      name: projectName,
      description: projectDescription,
      mode: "syncgenerating",
      feedback: BUILD_MARKER,
      answers: { rollbackStatus },
      rollbackStatus,
    }],
  ),
});

export const TriggerBuildStarted: Sync = (
  { request, path, projectId, backendDownloadUrl, frontendDownloadUrl },
) => {
  const backend = Symbol("backend");
  const frontend = Symbol("frontend");
  return {
    when: actions(
      [Requesting.request, { path, method: "POST" }, { request }],
      [Sandboxing.provision, { projectId, mode: "syncgenerating" }, {
        project: projectId,
        status: "complete",
        backendDownloadUrl,
        frontendDownloadUrl,
      }],
    ),
    where: async (frames) => {
      if (IS_SANDBOX) return frames.filter(() => false);
      frames = frames.filter((f) => {
        const p = f[path] as string;
        const pid = f[projectId] as string;
        return p === `/projects/${pid}/build`;
      });

      // Materialize nested payloads in-frame so Requesting.respond receives
      // plain objects instead of unresolved nested symbols.
      return frames.map((f) => ({
        ...f,
        [backend]: {
          status: "complete",
          downloadUrl: f[backendDownloadUrl],
        },
        [frontend]: {
          status: "complete",
          downloadUrl: f[frontendDownloadUrl],
        },
      })) as any;
    },
    then: actions(
      [Requesting.respond, {
        request,
        project: projectId,
        status: "complete",
        backend,
        frontend,
      }],
    ),
  };
};

export const TriggerBuildFailed: Sync = (
  { request, path, projectId, error, rollbackStatus },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, {
      projectId,
      mode: "syncgenerating",
      rollbackStatus,
    }, { error }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/build`;
    });
  },
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: rollbackStatus,
    }],
    [Requesting.respond, {
      request,
      project: projectId,
      statusCode: 500,
      error,
    }],
  ),
});

export const syncs = [
  TriggerBuild,
  TriggerBuildStarted,
  TriggerBuildFailed,
];
