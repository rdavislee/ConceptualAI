import { actions, Sync } from "@engine";
import {
  CredentialVault,
  Implementing,
  Planning,
  Previewing,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
  SyncGenerating,
} from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const ASSEMBLING_MARKER = "__ASSEMBLING__";

/**
 * TriggerAssembly - Gateway side.
 * Provisions a sandbox to run backend assembly.
 */
export const TriggerAssembly: Sync = (
  {
    projectId,
    plan,
    implementations,
    syncs,
    enableAutocomplete,
    token,
    userId,
    owner,
    request,
    path,
    projectDoc,
    geminiKey,
    geminiTier,
    geminiUnwrapKey,
    projectName,
    projectDescription,
  },
) => {
  const syncsList = Symbol("syncsList");
  const apiDef = Symbol("apiDef");
  const bundles = Symbol("bundles");
  const rollbackStatus = Symbol("rollbackStatus");
  const rollbackAutocomplete = Symbol("rollbackAutocomplete");
  const nextAutocomplete = Symbol("nextAutocomplete");
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

      // Parse path to extract projectId
      frames = frames.map((f) => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/assemble$/);
        if (match) {
          return { ...f, [projectId]: match[1] };
        }
        return null;
      }).filter((f) => f !== null) as any;

      // Authenticate
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

      // Do not proceed if this user already has an active sandbox.
      frames = await frames.query(Sandboxing._isActive, { userId }, { active });
      frames = frames.filter((f) => f[active] !== true);

      // Authorization
      frames = await frames.query(ProjectLedger._getOwner, {
        project: projectId,
      }, { owner });
      frames = frames.filter((f) => f[userId] === f[owner]);

      // Check project status
      frames = await frames.query(ProjectLedger._getProject, {
        project: projectId,
      }, { project: projectDoc });
      frames = frames.filter((f) => {
        const p = f[projectDoc] as any;
        return p &&
          (p.status === "syncs_generated" || p.status === "assembled" ||
            p.status === "complete");
      });
      frames = frames.map((f) => ({
        ...f,
        [rollbackStatus]: (f[projectDoc] as any).status,
        [rollbackAutocomplete]: (f[projectDoc] as any).autocomplete === true,
        [nextAutocomplete]: typeof f[enableAutocomplete] === "boolean"
          ? f[enableAutocomplete]
          : (f[projectDoc] as any).autocomplete === true,
      }));

      // Project context for sandbox provisioning
      frames = frames.map((f) => {
        const p = f[projectDoc] as any;
        return {
          ...f,
          [geminiKey]: f[geminiKey],
          [geminiTier]: f[geminiTier],
          [projectName]: p.name,
          [projectDescription]: p.description,
        };
      });

      // Fetch plan
      frames = await frames.query(Planning._getPlan, { project: projectId }, {
        plan,
      });
      frames = frames.map((f) => ({ ...f, [plan]: (f[plan] as any).plan }));

      // Fetch implementations
      frames = await frames.query(Implementing._getImplementations, {
        project: projectId,
      }, { implementations });

      // Fetch sync artifacts
      frames = await frames.query(SyncGenerating._getSyncs, {
        project: projectId,
      }, { syncs: syncsList, apiDefinition: apiDef, endpointBundles: bundles });
      frames = frames.map((f) => {
        const s = f[syncsList];
        const a = f[apiDef];
        const b = f[bundles];
        if (!s) return null;
        return {
          ...f,
          [syncs]: { syncs: s, apiDefinition: a, endpointBundles: b },
        };
      }).filter((f) => f !== null) as any;

      return frames;
    },
    then: actions(
      [Requesting.respond, {
        request,
        project: projectId,
        status: "assembling",
      }],
      [Previewing.teardown, { project: projectId }],
      [ProjectLedger.updateStatus, {
        project: projectId,
        status: "assembling",
      }],
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
        feedback: ASSEMBLING_MARKER,
        answers: { rollbackStatus },
        rollbackStatus,
        rollbackAutocomplete,
      }],
    ),
  };
};

export const TriggerAssemblyFailed: Sync = (
  { projectId, request, path, error, rollbackStatus, rollbackAutocomplete },
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
      return p === `/projects/${pid}/assemble`;
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

export const AssemblingRequestUnwrapErrorResponse: Sync = (
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
      /^\/projects\/[^/]+\/assemble$/.test(String(f[path] ?? ""))
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

export const syncs = [
  TriggerAssembly,
  TriggerAssemblyFailed,
  AssemblingRequestUnwrapErrorResponse,
];
