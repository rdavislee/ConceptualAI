import { actions, Sync } from "@engine";
import {
  GeminiCredentialVault,
  ConceptDesigning,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
} from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * TriggerImplementation - Gateway side.
 * Provisions a sandbox to handle the implementation phase.
 */
export const TriggerImplementation: Sync = (
  {
    projectId,
    enableAutocomplete,
    token,
    userId,
    owner,
    request,
    path,
    projectName,
    projectDescription,
    geminiKey,
    geminiTier,
    geminiUnwrapKey,
    projectDoc,
  },
) => {
  const designDoc = Symbol("designDoc");
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
        const match = p.match(/^\/projects\/([^\/]+)\/implement$/);
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
        GeminiCredentialVault._resolveCredential,
        { user: userId, unwrapKey: geminiUnwrapKey },
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
        return p && p.status === "design_complete";
      });

      // Verify Design exists
      frames = await frames.query(ConceptDesigning._getDesign, {
        project: projectId,
      }, { design: designDoc });
      frames = frames.filter((f) => f[designDoc] !== undefined);

      return frames.map((f) => {
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
    },
    then: actions(
      [Requesting.respond, {
        request,
        project: projectId,
        status: "implementing",
      }],
      [ProjectLedger.updateStatus, {
        project: projectId,
        status: "implementing",
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
        mode: "implementing",
        answers: { rollbackStatus },
        rollbackStatus,
        rollbackAutocomplete,
      }],
    ),
  };
};

export const TriggerImplementationFailed: Sync = (
  { request, path, projectId, error, rollbackStatus, rollbackAutocomplete },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [
      Sandboxing.provision,
      {
        projectId,
        mode: "implementing",
        rollbackStatus,
        rollbackAutocomplete,
      },
      { error },
    ],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/implement`;
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

export const ImplementingRequestUnwrapErrorResponse: Sync = (
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
      /^\/projects\/[^/]+\/implement$/.test(String(f[path] ?? ""))
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
  TriggerImplementation,
  TriggerImplementationFailed,
  ImplementingRequestUnwrapErrorResponse,
];
