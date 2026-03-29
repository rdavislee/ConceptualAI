import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Implementing, SyncGenerating, Assembling, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const SANDBOX_FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK") || "";
const SANDBOX_ID = Deno.env.get("SANDBOX_ID") || "";
const PROJECT_NAME = Deno.env.get("PROJECT_NAME") || "Untitled Project";
const PROJECT_DESCRIPTION = Deno.env.get("PROJECT_DESCRIPTION") || "";
const OWNER_ID = Deno.env.get("OWNER_ID") || "";
const ASSEMBLING_MARKER = "__ASSEMBLING__";
const BUILD_MARKER = "__BUILD__";

/**
 * AssemblySandboxStartup - Sandbox side.
 * Reuses startSyncGenerating action with a marker to run assembly in sandbox.
 */
export const AssemblySandboxStartup: Sync = (
  { projectId, plan, implementations, syncs, feedback, rollbackStatus },
) => {
  const syncsList = Symbol("syncsList");
  const apiDef = Symbol("apiDef");
  const bundles = Symbol("bundles");
  return {
    when: actions([
      Sandboxing.startSyncGenerating, { projectId, feedback, rollbackStatus }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      frames = frames.filter((f) => {
        const actionFeedback = String(f[feedback] ?? "");
        if (actionFeedback.startsWith(BUILD_MARKER)) return false;
        if (actionFeedback.startsWith(ASSEMBLING_MARKER)) return true;
        return SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER);
      });
      if (frames.length === 0) return frames;

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
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    return frames.filter((f) =>
      SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER) &&
      (f[project] as any)?.autocomplete !== true
    );
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "complete" }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  )
});

export const AssemblyAutocompleteContinue: Sync = ({ projectId, downloadUrl }) => ({
  when: actions(
    [Assembling.assemble, { project: projectId }, { downloadUrl }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    return frames.filter((f) =>
      SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER) &&
      (f[project] as any)?.autocomplete === true
    );
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "building" }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
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

export const AssemblySandboxError: Sync = (
  { projectId, error, feedback, rollbackStatus, effectiveRollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startSyncGenerating, { projectId, feedback, rollbackStatus }, {}],
    [Assembling.assemble, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames.map((f) => ({
      ...f,
      [effectiveRollbackStatus]:
        typeof f[rollbackStatus] === "string" && String(f[rollbackStatus]).length > 0
          ? f[rollbackStatus]
          : "syncs_generated",
    })).filter((f) => {
      const actionFeedback = String(f[feedback] ?? "");
      if (actionFeedback.startsWith(ASSEMBLING_MARKER)) return true;
      if (actionFeedback.startsWith(BUILD_MARKER)) return false;
      return SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER);
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
  )
});

export const syncs = [
  AssemblySandboxStartup,
  AssemblySandboxComplete,
  AssemblyAutocompleteContinue,
  AssemblySandboxError,
];
