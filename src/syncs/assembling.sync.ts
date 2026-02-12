import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Implementing, SyncGenerating, Assembling, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const SANDBOX_FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK") || "";
const ASSEMBLING_MARKER = "__ASSEMBLING__";
const SANDBOX_META_RAW = Deno.env.get("SANDBOX_CLARIFICATION_ANSWERS");
let SANDBOX_META: Record<string, string> = {};
if (SANDBOX_META_RAW) {
  try {
    SANDBOX_META = JSON.parse(SANDBOX_META_RAW);
  } catch (error) {
    console.error("[AssemblySandboxStartup] Failed to parse SANDBOX_CLARIFICATION_ANSWERS:", error);
  }
}
const ROLLBACK_STATUS = SANDBOX_META.rollbackStatus || "syncs_generated";

/**
 * AssemblySandboxStartup - Sandbox side.
 * Reuses startSyncGenerating action with a marker to run assembly in sandbox.
 */
export const AssemblySandboxStartup: Sync = ({ projectId, plan, implementations, syncs }) => {
  const syncsList = Symbol("syncsList");
  const apiDef = Symbol("apiDef");
  const bundles = Symbol("bundles");
  return {
    when: actions([
      Sandboxing.startSyncGenerating, { projectId }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      if (!SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);

      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
      frames = frames.map(f => ({...f, [plan]: (f[plan] as any).plan }));

      frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });
      frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs: syncsList, apiDefinition: apiDef, endpointBundles: bundles });

      frames = frames.map(f => {
          const s = f[syncsList];
          const a = f[apiDef];
          const b = f[bundles];
          if (!s) return null;
          return { ...f, [syncs]: { syncs: s, apiDefinition: a, endpointBundles: b } };
      }).filter(f => f !== null) as any;

      return frames;
    },
    then: actions(
      [Assembling.assemble, { project: projectId, plan, implementations, syncs }]
    ),
  };
};

export const AssemblySandboxComplete: Sync = ({ projectId, downloadUrl }) => ({
  when: actions(
    [Assembling.assemble, { project: projectId }, { downloadUrl }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    if (!SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "complete" }],
    [Sandboxing.exit, {}],
  )
});

export const AssemblySandboxError: Sync = ({ projectId, error }) => ({
  when: actions(
    [Assembling.assemble, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    if (!SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: ROLLBACK_STATUS }],
    [Sandboxing.exit, {}],
  )
});

export const syncs = [
  AssemblySandboxStartup,
  AssemblySandboxComplete,
  AssemblySandboxError,
];
