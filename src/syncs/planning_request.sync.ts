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
) => ({
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

    // Bind a fresh project ID (gateway side)
    return frames.map((f) => ({
      ...f,
      [projectId]: freshID(),
      [geminiKey]: f[geminiKey],
      [geminiTier]: f[geminiTier],
    }));
  },
  then: actions(
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
});

/**
 * PlanningRequestCompleteResponse - Gateway side.
 * Responds to POST /projects only after the planning sandbox completes.
 */
export const PlanningRequestCompleteResponse: Sync = (
  { request, projectId, plan },
) => ({
  when: actions(
    [Requesting.request, { path: "/projects", method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "planning" }, {
      project: projectId,
      status: "complete",
      plan,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [Requesting.respond, {
      request,
      project: projectId,
      status: "planning_complete",
      plan,
    }],
  ),
});

/**
 * PlanningRequestNeedsClarificationResponse - Gateway side.
 * Returns clarification questions from synchronous planning execution.
 */
export const PlanningRequestNeedsClarificationResponse: Sync = (
  { request, projectId, questions },
) => ({
  when: actions(
    [Requesting.request, { path: "/projects", method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "planning" }, {
      project: projectId,
      status: "needs_clarification",
      questions,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [Requesting.respond, {
      request,
      project: projectId,
      status: "awaiting_input",
      questions,
    }],
  ),
});

/**
 * PlanningRequestErrorResponse - Gateway side.
 * Returns planning sandbox execution errors.
 */
export const PlanningRequestErrorResponse: Sync = (
  { request, projectId, error },
) => ({
  when: actions(
    [Requesting.request, { path: "/projects", method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "planning" }, {
      project: projectId,
      status: "error",
      error,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [Requesting.respond, {
      request,
      project: projectId,
      statusCode: 500,
      error,
    }],
  ),
});

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
 * UserModifiesPlanCompleteResponse - Gateway side.
 * Responds to PUT /projects/:projectId/plan after modification sandbox completes.
 */
export const UserModifiesPlanCompleteResponse: Sync = (
  { request, path, projectId, plan },
) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Sandboxing.provision, { projectId, mode: "planning" }, {
      project: projectId,
      status: "complete",
      plan,
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
    [Requesting.respond, {
      request,
      project: projectId,
      status: "planning_complete",
      plan,
    }],
  ),
});

/**
 * UserModifiesPlanNeedsClarificationResponse - Gateway side.
 */
export const UserModifiesPlanNeedsClarificationResponse: Sync = (
  { request, path, projectId, questions },
) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Sandboxing.provision, { projectId, mode: "planning" }, {
      project: projectId,
      status: "needs_clarification",
      questions,
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
    [Requesting.respond, {
      request,
      project: projectId,
      status: "awaiting_input",
      questions,
    }],
  ),
});

/**
 * UserModifiesPlanErrorResponse - Gateway side.
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
    [Requesting.respond, {
      request,
      project: projectId,
      statusCode: 500,
      error,
    }],
  ),
});
