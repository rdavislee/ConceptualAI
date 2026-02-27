import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sandboxing, Sessioning } from "@concepts";
import { freshID } from "@utils/database.ts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

function isSandboxPipelineRoute(path: string, method: string): boolean {
  if (method === "POST" && path === "/projects") return true;
  if (method === "POST" && /^\/projects\/[^/]+\/clarify$/.test(path)) {
    return true;
  }
  if (method === "PUT" && /^\/projects\/[^/]+\/plan$/.test(path)) return true;
  if (
    (method === "POST" || method === "PUT") &&
    /^\/projects\/[^/]+\/design$/.test(path)
  ) {
    return true;
  }
  if (method === "POST" && /^\/projects\/[^/]+\/implement$/.test(path)) {
    return true;
  }
  if (method === "POST" && /^\/projects\/[^/]+\/syncs$/.test(path)) return true;
  if (method === "POST" && /^\/projects\/[^/]+\/assemble$/.test(path)) {
    return true;
  }
  if (method === "POST" && /^\/projects\/[^/]+\/build$/.test(path)) return true;
  return false;
}

/**
 * RejectTierZeroSandboxPipelineRequest - Gateway side.
 * Rejects tier 0 before any sandbox-triggering concept actions execute.
 */
export const RejectTierZeroSandboxPipelineRequest: Sync = (
  { request, path, method, geminiTier },
) => ({
  when: actions([
    Requesting.request,
    { path, method, geminiTier },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);

    return frames.filter((f) => {
      const requestPath = (f[path] as string) || "";
      const requestMethod = ((f[method] as string) || "").toUpperCase();
      const tier = ((f[geminiTier] as string) || "").trim();
      return tier === "0" &&
        isSandboxPipelineRoute(requestPath, requestMethod);
    });
  },
  then: actions(
    [Requesting.respond, {
      request,
      statusCode: 400,
      error: "Gemini tier 0/free is unsupported for sandbox pipeline requests.",
    }],
  ),
});

/**
 * RejectConcurrentSandboxPipelineRequest - Gateway side.
 * Explicitly rejects sandbox pipeline requests when user already has an active sandbox.
 */
export const RejectConcurrentSandboxPipelineRequest: Sync = (
  { request, path, method, token, userId, active },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);

    // Only guard sandbox pipeline routes.
    frames = frames.filter((f) => {
      const requestPath = (f[path] as string) || "";
      const requestMethod = ((f[method] as string) || "").toUpperCase();
      return isSandboxPipelineRoute(requestPath, requestMethod);
    });

    // Require authenticated user before checking active sandbox status.
    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
    });
    frames = frames.filter((f) => f[userId] !== undefined);

    // Reject when user already has a running/provisioning sandbox.
    frames = await frames.query(Sandboxing._isActive, { userId }, { active });
    return frames.filter((f) => f[active] === true);
  },
  then: actions(
    [Requesting.respond, {
      request,
      statusCode: 409,
      error:
        "Cannot run concurrent sandbox jobs. Wait for the current sandbox to finish before starting another.",
    }],
  ),
});

/**
 * PlanningRequest - Catch the initial planning request on the Gateway.
 * Provisions a sandbox and creates a project record.
 */
export const PlanningRequest: Sync = (
  {
    name,
    description,
    token,
    userId,
    projectId,
    request,
    geminiKey,
    geminiTier,
  },
) => {
  const active = Symbol("active");
  return {
  when: actions([
    Requesting.request,
    {
      path: "/projects",
      method: "POST",
      name,
      description,
      accessToken: token,
      geminiKey,
      geminiTier,
    },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);

    // Authenticate user
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

    // Filter out unauthorized requests
    frames = frames.filter((f) => f[userId] !== undefined);

    // Do not proceed if this user already has an active sandbox.
    frames = await frames.query(Sandboxing._isActive, { userId }, { active });
    frames = frames.filter((f) => f[active] !== true);

    // Bind a fresh project ID (gateway side)
    return frames.map((f) => ({
      ...f,
      [projectId]: freshID(),
      [geminiKey]: f[geminiKey],
      [geminiTier]: f[geminiTier],
    }));
  },
  then: actions(
    [Requesting.respond, {
      request,
      project: projectId,
      status: "planning",
    }],
    [ProjectLedger.create, {
      owner: userId,
      project: projectId,
      name,
      description,
    }],
    [
      Sandboxing.provision,
      {
        userId,
        apiKey: geminiKey,
        apiTier: geminiTier,
        projectId,
        name,
        description,
        mode: "planning",
      },
    ],
  ),
  };
};

/**
 * UserModifiesPlanRequest - Gateway side.
 * Provisions a sandbox to handle plan modification.
 */
export const UserModifiesPlanRequest: Sync = (
  {
    projectId,
    feedback,
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
  const active = Symbol("active");
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
        const match = p.match(/^\/projects\/([^\/]+)\/plan$/);
        if (match) {
          return { ...f, [projectId]: match[1] };
        }
        return null;
      }).filter((f) => f !== null) as any;

      // Authenticate
      frames = await frames.query(Sessioning._getUser, { session: token }, {
        user: userId,
      });

      // Do not proceed if this user already has an active sandbox.
      frames = await frames.query(Sandboxing._isActive, { userId }, { active });
      frames = frames.filter((f) => f[active] !== true);

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
      [Requesting.respond, {
        request,
        project: projectId,
        status: "planning",
      }],
      [ProjectLedger.updateStatus, { project: projectId, status: "planning" }],
      [
        Sandboxing.provision,
        {
          userId,
          apiKey: geminiKey,
          apiTier: geminiTier,
          projectId,
          name: projectName,
          description: projectDescription,
          mode: "planning",
          feedback,
          answers: { rollbackStatus },
          rollbackStatus,
        },
      ],
    ),
  };
};

/**
 * UserModifiesPlanErrorResponse - Gateway side.
 * Rolls back project status on sandbox provision failure.
 */
export const UserModifiesPlanErrorResponse: Sync = (
  { request, path, projectId, error, rollbackStatus },
) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Sandboxing.provision, { projectId, mode: "planning", rollbackStatus }, {
      project: projectId,
      status: "error",
      error,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/plan`;
    });
  },
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: rollbackStatus,
    }],
  ),
});
