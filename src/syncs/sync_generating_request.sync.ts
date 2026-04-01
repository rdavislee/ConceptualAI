import { actions, Sync } from "@engine";
import {
  CredentialVault,
  Implementing,
  Planning,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
} from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * TriggerSyncGeneration - Gateway side.
 * Provisions a sandbox to handle the sync generation phase.
 */
export const TriggerSyncGeneration: Sync = (
  {
    projectId,
    plan,
    implementations,
    token,
    enableAutocomplete,
    userId,
    owner,
    request,
    path,
    projectDoc,
    conceptSpecs,
    projectName,
    projectDescription,
    geminiKey,
    geminiTier,
    geminiUnwrapKey,
  },
) => {
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
        const match = p.match(/^\/projects\/([^\/]+)\/syncs$/);
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

      // Authorization: Check if user owns the project
      frames = await frames.query(ProjectLedger._getOwner, {
        project: projectId,
      }, { owner });
      frames = frames.filter((f) => f[userId] === f[owner]);

      // Check Project Status
      frames = await frames.query(ProjectLedger._getProject, {
        project: projectId,
      }, { project: projectDoc });
      frames = frames.filter((f) => {
        const p = f[projectDoc] as any;
        return p &&
          (p.status === "implemented" || p.status === "syncs_generated");
      });

      // Fetch Plan
      frames = await frames.query(Planning._getPlan, { project: projectId }, {
        plan,
      });
      frames = frames.filter((f) => {
        const p = (f[plan] as any)?.plan;
        return p !== undefined;
      });

      // Fetch Implementations and build conceptSpecs
      frames = await frames.query(Implementing._getImplementations, {
        project: projectId,
      }, { implementations });

      return frames.map((f) => {
        const impls = f[implementations] as any;
        if (!impls || Object.keys(impls).length === 0) return null;

        let specs = "";
        for (const [name, impl] of Object.entries(impls)) {
          specs += `--- CONCEPT: ${name} ---\n${(impl as any).spec}\n\n`;
        }

        const p = f[projectDoc] as any;
        return {
          ...f,
          [conceptSpecs]: specs,
          [projectName]: p.name,
          [projectDescription]: p.description,
          [geminiKey]: f[geminiKey],
          [geminiTier]: f[geminiTier],
          [rollbackStatus]: p.status,
          [rollbackAutocomplete]: p.autocomplete === true,
          [nextAutocomplete]: typeof f[enableAutocomplete] === "boolean"
            ? f[enableAutocomplete]
            : p.autocomplete === true,
        };
      }).filter((f) => f !== null) as any;
    },
    then: actions(
      [Requesting.respond, {
        request,
        project: projectId,
        status: "sync_generating",
      }],
      [ProjectLedger.updateStatus, {
        project: projectId,
        status: "sync_generating",
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
        answers: { rollbackStatus },
        rollbackStatus,
        rollbackAutocomplete,
      }],
    ),
  };
};

export const TriggerSyncGenerationFailed: Sync = (
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
      return p === `/projects/${pid}/syncs`;
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

export const SyncGeneratingRequestUnwrapErrorResponse: Sync = (
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
      /^\/projects\/[^/]+\/syncs$/.test(String(f[path] ?? ""))
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
  TriggerSyncGeneration,
  TriggerSyncGenerationFailed,
  SyncGeneratingRequestUnwrapErrorResponse,
];
