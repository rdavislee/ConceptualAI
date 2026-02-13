import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sandboxing, Sessioning } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * TriggerDesign - Gateway side.
 * Provisions a sandbox to handle the design phase.
 */
export const TriggerDesign: Sync = (
  {
    projectId,
    token,
    userId,
    owner,
    request,
    path,
    projectName,
    projectDescription,
    geminiKey,
    geminiTier,
  },
) => {
  const doc = Symbol("doc");
  const rollbackStatus = Symbol("rollbackStatus");
  return {
    when: actions([
      Requesting.request,
      { path, method: "POST", accessToken: token, geminiKey, geminiTier },
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

      // Require non-empty credentials and supported tier for sandbox pipeline triggers
      frames = frames.filter((f) => {
        const key = (f[geminiKey] as string) || "";
        const tier = (f[geminiTier] as string) || "";
        return key.trim().length > 0 &&
          (tier === "1" || tier === "2" || tier === "3");
      });

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
        };
      }).filter((f) => f !== null) as any;
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
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
    token,
    userId,
    owner,
    request,
    path,
    projectName,
    projectDescription,
    geminiKey,
    geminiTier,
    feedback,
  },
) => {
  const doc = Symbol("doc");
  const rollbackStatus = Symbol("rollbackStatus");
  return {
    when: actions([
      Requesting.request,
      {
        path,
        method: "PUT",
        feedback,
        accessToken: token,
        geminiKey,
        geminiTier,
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

      // Require non-empty credentials and supported tier for sandbox pipeline triggers
      frames = frames.filter((f) => {
        const key = (f[geminiKey] as string) || "";
        const tier = (f[geminiTier] as string) || "";
        return key.trim().length > 0 &&
          (tier === "1" || tier === "2" || tier === "3");
      });

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
        };
      }).filter((f) => f !== null) as any;
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
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
      }],
    ),
  };
};

export const TriggerDesignStarted: Sync = (
  { request, path, projectId, design },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "designing" }, {
      project: projectId,
      status: "complete",
      design,
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
  then: actions(
    [Requesting.respond, {
      request,
      project: projectId,
      status: "design_complete",
      design,
    }],
  ),
});

export const TriggerDesignFailed: Sync = (
  { request, path, projectId, error, rollbackStatus },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "designing", rollbackStatus }, {
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

export const UserModifiesDesignStarted: Sync = (
  { request, path, projectId, design },
) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Sandboxing.provision, { projectId, mode: "designing" }, {
      project: projectId,
      status: "complete",
      design,
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
  then: actions(
    [Requesting.respond, {
      request,
      project: projectId,
      status: "design_complete",
      design,
    }],
  ),
});

export const UserModifiesDesignFailed: Sync = (
  { request, path, projectId, error, rollbackStatus },
) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Sandboxing.provision, { projectId, mode: "designing", rollbackStatus }, {
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
