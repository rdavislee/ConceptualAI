import { actions, Sync } from "@engine";
import {
  GeminiCredentialVault,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
} from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const BUILD_MARKER = "__BUILD__";

/**
 * TriggerBuild - Gateway side.
 * Provisions one sandbox that performs backend assembly and frontend generation.
 */
export const TriggerBuild: Sync = (
  {
    projectId,
    enableAutocomplete,
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
    geminiUnwrapKey,
    rollbackStatus,
    rollbackAutocomplete,
    nextAutocomplete,
  },
) => {
  const active = Symbol("active");
  return {
  when: actions([
    Requesting.request,
    {
      path,
      method: "POST",
      enableAutocomplete,
      accessToken: token,
      geminiUnwrapKey,
    },
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
    frames = frames.filter((f) => f[userId] !== undefined);
    frames = await frames.query(
      GeminiCredentialVault._resolveCredential,
      { user: userId, unwrapKey: geminiUnwrapKey },
      { geminiKey, geminiTier },
    );
    frames = frames.filter((f) =>
      typeof f[geminiKey] === "string" && typeof f[geminiTier] === "string"
    );
    console.log("[TriggerBuildRequest] after auth:", frames.length);

    // Do not proceed if this user already has an active sandbox.
    frames = await frames.query(Sandboxing._isActive, { userId }, { active });
    frames = frames.filter((f) => f[active] !== true);

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
        [rollbackAutocomplete]: p.autocomplete === true,
        [nextAutocomplete]: f[enableAutocomplete] === true
          ? true
          : p.autocomplete === true,
      };
    });
    console.log("[TriggerBuildRequest] final frames:", out.length);
    return out;
  },
  then: actions(
    [Requesting.respond, { request, project: projectId, status: "building" }],
    [ProjectLedger.updateStatus, { project: projectId, status: "building" }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: nextAutocomplete,
    }],
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
      rollbackAutocomplete,
    }],
  ),
  };
};

export const TriggerBuildFailed: Sync = (
  { request, path, projectId, error, rollbackStatus, rollbackAutocomplete },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, {
      projectId,
      mode: "syncgenerating",
      rollbackStatus,
      rollbackAutocomplete,
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
  then: actions([ProjectLedger.updateStatus, {
    project: projectId,
    status: rollbackStatus,
  }], [ProjectLedger.updateAutocomplete, {
    project: projectId,
    autocomplete: rollbackAutocomplete,
  }]),
});

export const BuildRequestUnwrapErrorResponse: Sync = (
  { request, path, token, userId, geminiUnwrapKey, error, statusCode },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token, geminiUnwrapKey },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    frames = frames.filter((f) =>
      /^\/projects\/[^/]+\/build$/.test(String(f[path] ?? ""))
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

export const syncs = [
  TriggerBuild,
  TriggerBuildFailed,
  BuildRequestUnwrapErrorResponse,
];
