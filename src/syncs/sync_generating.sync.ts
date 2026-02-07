import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Planning, Implementing, SyncGenerating, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

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
      if (!IS_SANDBOX) return [];
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
    if (!IS_SANDBOX) return [];
    if (frames.length === 0) return [];
    console.log(`[SyncGenerationSandboxExit] Triggering exit for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
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
        if (IS_SANDBOX) return [];

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
  GetSyncs
];
