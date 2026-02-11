import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Planning, Implementing, SyncGenerating, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const SANDBOX_META_RAW = Deno.env.get("SANDBOX_CLARIFICATION_ANSWERS");
let SANDBOX_META: Record<string, string> = {};
if (SANDBOX_META_RAW) {
  try {
    SANDBOX_META = JSON.parse(SANDBOX_META_RAW);
  } catch (error) {
    console.error("[SyncGenerationSandboxStartup] Failed to parse SANDBOX_CLARIFICATION_ANSWERS:", error);
  }
}
const ROLLBACK_STATUS = SANDBOX_META.rollbackStatus || "implemented";
const SANDBOX_FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK");
const ASSEMBLING_MARKER = "__ASSEMBLING__";

/**
 * SyncGenerationSandboxStartup - Sandbox side.
 * Triggers sync generation when the sandbox starts up.
 */
export const SyncGenerationSandboxStartup: Sync = ({ projectId, plan, implementations, conceptSpecs }) => {
  return {
    when: actions([
      Sandboxing.startSyncGenerating, { projectId }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      if ((SANDBOX_FEEDBACK || "").startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);
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
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "syncs_generated" }],
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
    if (frames.length === 0) return frames.filter(() => false);
    console.log(`[SyncGenerationSandboxExit] Triggering exit for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
});

/**
 * SyncGenerationErrorRollback - Sandbox side.
 * Reverts project status when sync generation fails.
 */
export const SyncGenerationErrorRollback: Sync = ({ projectId, error }) => ({
  when: actions(
    [SyncGenerating.generate, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    if ((SANDBOX_FEEDBACK || "").startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: ROLLBACK_STATUS }],
    [Sandboxing.exit, {}],
  ),
});

/**
 * GetSyncs - Gateway side query handler.
 */
export const GetSyncs: Sync = ({ projectId, syncs, apiDefinition, endpointBundles, token, userId, owner, request, path }) => ({
    when: actions([
        Requesting.request,
        { path, method: "GET", accessToken: token },
        { request }
    ]),
    where: async (frames) => {
        if (IS_SANDBOX) return frames.filter(() => false);

        // Parse path
        frames = frames.map(f => {
            const p = f[path] as string;
            if (!p) return null;
            const match = p.match(/^\/projects\/([^\/]+)\/syncs$/);
            if (match) {
                return { ...f, [projectId]: match[1] };
            }
            return null;
        }).filter(f => f !== null) as any;

        // Authenticate/Authorize
        frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
        frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
        frames = frames.filter(f => f[userId] === f[owner]);

        // Fetch Syncs
        frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs, apiDefinition, endpointBundles });
        return frames.filter(f => f[syncs]);
    },
    then: actions([
        Requesting.respond,
        { request, syncs, apiDefinition, endpointBundles }
    ])
});

export const syncs = [
  SyncGenerationSandboxStartup,
  SyncGenerationComplete,
  SyncGenerationSandboxExit,
  SyncGenerationErrorRollback,
  GetSyncs
];
