import { actions, Sync } from "@engine";
import {
  CredentialVault,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
} from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * TriggerDesign - Gateway side.
 * Provisions a sandbox to handle the design phase.
 */
export const TriggerDesign: Sync = (
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
  },
) => {
  const doc = Symbol("doc");
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
        const match = p.match(/^\/projects\/([^\/]+)\/design$/);
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

      // Get project context for sandbox
      frames = await frames.query(ProjectLedger._getProject, {
        project: projectId,
      }, { project: doc });

      return frames.map((f) => {
        const p = f[doc] as any;
        if (!p) return null;
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
      }).filter((f) => f !== null) as any;
    },
    then: actions(
      [Requesting.respond, { request, project: projectId, status: "designing" }],
      [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
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
        mode: "designing",
        answers: { rollbackStatus },
        rollbackStatus,
        rollbackAutocomplete,
      }],
    ),
  };
};

/**
 * UserModifiesDesign - Gateway side.
 * Provisions a sandbox to handle the design modification phase.
 */
export const UserModifiesDesign: Sync = (
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
    feedback,
  },
) => {
  const doc = Symbol("doc");
  const rollbackStatus = Symbol("rollbackStatus");
  const rollbackAutocomplete = Symbol("rollbackAutocomplete");
  const nextAutocomplete = Symbol("nextAutocomplete");
  const active = Symbol("active");
  return {
    when: actions([
      Requesting.request,
      {
        path,
        method: "PUT",
        feedback,
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
        const match = p.match(/^\/projects\/([^\/]+)\/design$/);
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

      // Get project context for sandbox
      frames = await frames.query(ProjectLedger._getProject, {
        project: projectId,
      }, { project: doc });

      return frames.map((f) => {
        const p = f[doc] as any;
        if (!p) return null;
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
      }).filter((f) => f !== null) as any;
    },
    then: actions(
      [Requesting.respond, { request, project: projectId, status: "designing" }],
      [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
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
        mode: "designing",
        feedback,
        answers: { rollbackStatus },
        rollbackStatus,
        rollbackAutocomplete,
      }],
    ),
  };
};

export const TriggerDesignFailed: Sync = (
  { request, path, projectId, error, rollbackStatus, rollbackAutocomplete },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, {
      projectId,
      mode: "designing",
      rollbackStatus,
      rollbackAutocomplete,
    }, {
      error,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/design`;
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

export const UserModifiesDesignFailed: Sync = (
  { request, path, projectId, error, rollbackStatus, rollbackAutocomplete },
) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Sandboxing.provision, {
      projectId,
      mode: "designing",
      rollbackStatus,
      rollbackAutocomplete,
    }, {
      error,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/design`;
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

export const DesigningRequestUnwrapErrorResponse: Sync = (
  { request, path, method, token, userId, geminiUnwrapKey, error, statusCode },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken: token, geminiUnwrapKey },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    frames = frames.filter((f) => {
      const requestPath = String(f[path] ?? "");
      const requestMethod = String(f[method] ?? "").toUpperCase();
      return /^\/projects\/[^/]+\/design$/.test(requestPath) &&
        (requestMethod === "POST" || requestMethod === "PUT");
    });
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
  TriggerDesign,
  UserModifiesDesign,
  TriggerDesignFailed,
  UserModifiesDesignFailed,
  DesigningRequestUnwrapErrorResponse,
];
