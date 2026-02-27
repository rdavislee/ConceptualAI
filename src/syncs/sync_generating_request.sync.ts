import { actions, Sync } from "@engine";
import {
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
  },
) => {
  const rollbackStatus = Symbol("rollbackStatus");
  const active = Symbol("active");
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
      }],
    ),
  };
};

export const TriggerSyncGenerationFailed: Sync = (
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
      return p === `/projects/${pid}/syncs`;
    });
  },
  then: actions([ProjectLedger.updateStatus, {
    project: projectId,
    status: rollbackStatus,
  }]),
});

export const syncs = [
  TriggerSyncGeneration,
  TriggerSyncGenerationFailed,
];
