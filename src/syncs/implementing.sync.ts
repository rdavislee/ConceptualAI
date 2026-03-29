import { actions, Sync } from "@engine";
import { ProjectLedger, ConceptDesigning, Implementing, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const SANDBOX_ID = Deno.env.get("SANDBOX_ID") || "";
const PROJECT_NAME = Deno.env.get("PROJECT_NAME") || "Untitled Project";
const PROJECT_DESCRIPTION = Deno.env.get("PROJECT_DESCRIPTION") || "";
const OWNER_ID = Deno.env.get("OWNER_ID") || "";

/**
 * ImplementationSandboxStartup - Sandbox side.
 * Triggers implementation when the implementation sandbox starts up.
 */
export const ImplementationSandboxStartup: Sync = ({ projectId, design, rollbackStatus }) => {
  return {
    when: actions([
      Sandboxing.startImplementing, { projectId, rollbackStatus }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      console.log(`[ImplementationSandboxStartup] Starting implementation for project ${frames[0][projectId]}`);

      // Fetch the Design from DB
      frames = await frames.query(ConceptDesigning._getDesign, { project: projectId }, { design });
      return frames.filter(f => f[design] !== undefined);
    },
    then: actions(
      [Implementing.implementAll, { project: projectId, design }]
    ),
  };
};

/**
 * ImplementationComplete - Gateway/Sandbox
 * Updates status when implementation is complete.
 */
export const ImplementationComplete: Sync = ({ projectId, implementations }) => ({
  when: actions(
    [Implementing.implementAll, { project: projectId }, { implementations }],
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
    [ProjectLedger.updateStatus, { project: projectId, status: "implemented" }],
  ),
});

export const ImplementationAutocompleteContinue: Sync = (
  { projectId, implementations },
) => ({
  when: actions(
    [Implementing.implementAll, { project: projectId }, { implementations }],
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
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "sync_generating",
    }],
    [Sandboxing.touch, { sandboxId: SANDBOX_ID }],
    [Sandboxing.startSyncGenerating, {
      projectId,
      name: PROJECT_NAME,
      description: PROJECT_DESCRIPTION,
      ownerId: OWNER_ID,
      feedback: "",
      rollbackStatus: "implemented",
    }],
  ),
});

/**
 * ImplementationSandboxExit - Sandbox side.
 * Terminates the container after implementation is done.
 */
export const ImplementationSandboxExit: Sync = ({ projectId, implementations }) => ({
  when: actions(
    [Implementing.implementAll, { project: projectId }, { implementations }],
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
    console.log(`[ImplementationSandboxExit] Triggering exit for project ${frames[0][projectId]}`);
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
 * ImplementationErrorRollback - Sandbox side.
 * Reverts project status when implementation fails.
 */
export const ImplementationErrorRollback: Sync = (
  { projectId, error, rollbackStatus, effectiveRollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startImplementing, { projectId, rollbackStatus }, {}],
    [Implementing.implementAll, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames.map((f) => ({
      ...f,
      [effectiveRollbackStatus]:
        typeof f[rollbackStatus] === "string" && String(f[rollbackStatus]).length > 0
          ? f[rollbackStatus]
          : "design_complete",
    }));
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

export const syncs = [
  ImplementationSandboxStartup,
  ImplementationComplete,
  ImplementationAutocompleteContinue,
  ImplementationSandboxExit,
  ImplementationErrorRollback,
];
