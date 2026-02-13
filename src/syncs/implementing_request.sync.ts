import { actions, Sync } from "@engine";
import {
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
    token,
    userId,
    owner,
    request,
    path,
    projectName,
    projectDescription,
    geminiKey,
    geminiTier,
    projectDoc,
  },
) => {
  const designDoc = Symbol("designDoc");
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
        };
      });
    },
    then: actions(
      [ProjectLedger.updateStatus, {
        project: projectId,
        status: "implementing",
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
      }],
    ),
  };
};

export const TriggerImplementationStarted: Sync = (
  { request, path, projectId, implementations },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "implementing" }, {
      project: projectId,
      status: "complete",
      implementations,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/implement`;
    });
  },
  then: actions(
    [Requesting.respond, {
      request,
      project: projectId,
      status: "implemented",
      implementations,
    }],
  ),
});

export const TriggerImplementationFailed: Sync = (
  { request, path, projectId, error, rollbackStatus },
) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [
      Sandboxing.provision,
      { projectId, mode: "implementing", rollbackStatus },
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
  TriggerImplementation,
  TriggerImplementationStarted,
  TriggerImplementationFailed,
];
