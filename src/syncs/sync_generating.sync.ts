import { actions, Frames, Sync } from "@engine";
import { ProjectLedger, Requesting, Sandboxing, Sessioning, Planning, Implementing, SyncGenerating } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const SANDBOX_ID = Deno.env.get("SANDBOX_ID") || "";
const PROJECT_NAME = Deno.env.get("PROJECT_NAME") || "Untitled Project";
const PROJECT_DESCRIPTION = Deno.env.get("PROJECT_DESCRIPTION") || "";
const OWNER_ID = Deno.env.get("OWNER_ID") || "";
const SANDBOX_FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK");
const ASSEMBLING_MARKER = "__ASSEMBLING__";
const BUILD_MARKER = "__BUILD__";

/**
 * SyncGenerationSandboxStartup - Sandbox side.
 * Triggers sync generation when the sandbox starts up.
 */
export const SyncGenerationSandboxStartup: Sync = (
  { projectId, plan, implementations, conceptSpecs, feedback, rollbackStatus },
) => {
  return {
    when: actions([
      Sandboxing.startSyncGenerating, { projectId, feedback, rollbackStatus }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      frames = frames.filter((f) => {
        const actionFeedback = String(f[feedback] ?? "");
        if ((SANDBOX_FEEDBACK || "").startsWith(ASSEMBLING_MARKER)) return false;
        if ((SANDBOX_FEEDBACK || "").startsWith(BUILD_MARKER)) return false;
        if (actionFeedback.startsWith(ASSEMBLING_MARKER)) return false;
        if (actionFeedback.startsWith(BUILD_MARKER)) return false;
        return true;
      });
      if (frames.length === 0) return frames;
      console.log(`[SyncGenerationSandboxStartup] Starting sync generation for project ${frames[0][projectId]}`);

      // Fetch Plan from DB
      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
      frames = frames.filter(f => (f[plan] as any)?.plan !== undefined).map(f => ({...f, [plan]: (f[plan] as any).plan }));

      // Fetch Implementations to build conceptSpecs
      frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });
      return frames.map(f => {
          const impls = f[implementations] as any;
          if (!impls || Object.keys(impls).length === 0) return null;

          let specs = "";
          for (const [name, impl] of Object.entries(impls)) {
              specs += `--- CONCEPT: ${name} ---\n${(impl as any).spec}\n\n`;
          }
          return { ...f, [conceptSpecs]: specs };
      }).filter(f => f !== null) as any;
    },
    then: actions(
      [SyncGenerating.generate, { project: projectId, plan, conceptSpecs, implementations }]
    ),
  };
};

/**
 * SyncGenerationComplete - Gateway/Sandbox
 * Updates status when sync generation is complete.
 */
export const SyncGenerationComplete: Sync = ({ projectId, apiDefinition, endpointBundles }) => ({
  when: actions(
    [SyncGenerating.generate, { project: projectId }, { apiDefinition, endpointBundles }],
  ),
  where: async (frames) => {
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    return frames.filter((f) => (f[project] as any)?.autocomplete !== true);
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "syncs_generated" }],
  ),
});

export const SyncGenerationAutocompleteContinue: Sync = (
  { projectId, apiDefinition, endpointBundles },
) => ({
  when: actions(
    [SyncGenerating.generate, { project: projectId }, { apiDefinition, endpointBundles }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    return frames.filter((f) => (f[project] as any)?.autocomplete === true);
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "building" }],
    [Sandboxing.touch, { sandboxId: SANDBOX_ID }],
    [Sandboxing.startSyncGenerating, {
      projectId,
      name: PROJECT_NAME,
      description: PROJECT_DESCRIPTION,
      ownerId: OWNER_ID,
      feedback: BUILD_MARKER,
      rollbackStatus: "syncs_generated",
    }],
  ),
});

/**
 * SyncGenerationSandboxExit - Sandbox side.
 * Terminates the container after sync generation is done.
 */
export const SyncGenerationSandboxExit: Sync = ({ projectId, apiDefinition }) => ({
  when: actions(
    [SyncGenerating.generate, { project: projectId }, { apiDefinition }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    frames = frames.filter((f) => (f[project] as any)?.autocomplete !== true);
    if (frames.length === 0) return frames.filter(() => false);
    console.log(`[SyncGenerationSandboxExit] Triggering exit for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}]
  )
});

/**
 * SyncGenerationErrorRollback - Sandbox side.
 * Reverts project status when sync generation fails.
 */
export const SyncGenerationErrorRollback: Sync = (
  { projectId, error, feedback, rollbackStatus, effectiveRollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startSyncGenerating, { projectId, feedback, rollbackStatus }, {}],
    [SyncGenerating.generate, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames.map((f) => ({
      ...f,
      [effectiveRollbackStatus]:
        typeof f[rollbackStatus] === "string" && String(f[rollbackStatus]).length > 0
          ? f[rollbackStatus]
          : "implemented",
    })).filter((f) => {
      const actionFeedback = String(f[feedback] ?? "");
      if ((SANDBOX_FEEDBACK || "").startsWith(ASSEMBLING_MARKER)) return false;
      if ((SANDBOX_FEEDBACK || "").startsWith(BUILD_MARKER)) return false;
      if (actionFeedback.startsWith(ASSEMBLING_MARKER)) return false;
      if (actionFeedback.startsWith(BUILD_MARKER)) return false;
      return true;
    }) as any;
  },
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: effectiveRollbackStatus,
    }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  ),
});

/**
 * GetSyncs - Gateway side query handler.
 */
export const GetSyncs: Sync = ({ projectId, syncs, apiDefinition, endpointBundles, token, userId, projectObj, request, path }) => ({
    when: actions([
        Requesting.request,
        { path, method: "GET", accessToken: token },
        { request }
    ]),
    where: async (frames) => {
        if (IS_SANDBOX) return frames.filter(() => false);

        frames = frames.map(f => {
            const p = f[path] as string;
            if (!p) return null;
            const match = p.match(/^\/projects\/([^\/]+)\/syncs$/);
            if (match) {
                return { ...f, [projectId]: match[1] };
            }
            return null;
        }).filter(f => f !== null) as any;

        frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
        frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectObj });
        frames = frames.filter(f => {
          const p = f[projectObj] as any;
          return p && !p.error && p.owner === f[userId];
        });

        const result = new Frames();
        for (const f of frames) {
          const p = f[projectObj] as any;
          if (p.status === "sync_generating") {
            result.push({ ...f, [syncs]: { status: "sync_generating" }, [apiDefinition]: null, [endpointBundles]: null });
            continue;
          }
          const syncRows = await SyncGenerating._getSyncs({ project: f[projectId] as any });
          if (syncRows.length > 0) {
            const row = syncRows[0] as any;
            result.push({ ...f, [syncs]: row.syncs, [apiDefinition]: row.apiDefinition, [endpointBundles]: row.endpointBundles });
          }
        }
        return result;
    },
    then: actions([
        Requesting.respond,
        { request, syncs, apiDefinition, endpointBundles }
    ])
});

export const syncs = [
  SyncGenerationSandboxStartup,
  SyncGenerationComplete,
  SyncGenerationAutocompleteContinue,
  SyncGenerationSandboxExit,
  SyncGenerationErrorRollback,
  GetSyncs,
];
