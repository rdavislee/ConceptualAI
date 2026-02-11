import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, Sessioning, ConceptDesigning, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK");
const SANDBOX_META_RAW = Deno.env.get("SANDBOX_CLARIFICATION_ANSWERS");
let SANDBOX_META: Record<string, string> = {};
if (SANDBOX_META_RAW) {
  try {
    SANDBOX_META = JSON.parse(SANDBOX_META_RAW);
  } catch (error) {
    console.error("[DesignSandboxStartup] Failed to parse SANDBOX_CLARIFICATION_ANSWERS:", error);
  }
}
const ROLLBACK_STATUS = SANDBOX_META.rollbackStatus || (FEEDBACK ? "design_complete" : "planning_complete");

/**
 * DesignSandboxStartup - Sandbox side.
 * Triggers designing or modification when the design sandbox starts up.
 */
export const DesignSandboxStartup: Sync = ({ projectId, description, name, ownerId, plan, design }) => {
  const pDoc = Symbol("pDoc");
  return {
    when: actions([
      Sandboxing.startDesigning, { projectId, name, description, ownerId }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      console.log(`[DesignSandboxStartup] Matching for project ${frames[0][projectId]}`);

      // Fetch the Plan from DB
      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan: pDoc });

      const newFrames: any[] = [];
      for (const f of frames) {
          const planDoc = f[pDoc] as any;
          if (!planDoc || !planDoc.plan) {
              console.warn(`[DesignSandboxStartup] No plan found for project ${f[projectId]}`);
              continue;
          }

          // Optional design lookup
          const designDocs = await ConceptDesigning._getDesign({ project: f[projectId] as any });
          const designDoc = designDocs.length > 0 ? designDocs[0].design : null;

          newFrames.push({
              ...f,
              [plan]: planDoc.plan,
              [design]: designDoc
          });
      }
      const out = frames.filter(() => false);
      out.push(...newFrames as any[]);
      return out;
    },
    then: actions(
      // Determine if it's a new design or modification
      FEEDBACK
        ? [ConceptDesigning.modify, { project: projectId, plan, feedback: FEEDBACK }]
        : [ConceptDesigning.design, { project: projectId, plan }]
    ),
  };
};

/**
 * InitialDesignComplete - Gateway/Sandbox
 * Updates status when the first design is complete.
 */
export const InitialDesignComplete: Sync = ({ projectId, design }) => ({
  when: actions(
    [ConceptDesigning.design, { project: projectId }, { design }],
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "design_complete" }],
  ),
});

/**
 * ModificationComplete - Gateway/Sandbox
 * Updates status when a modification is complete.
 */
export const ModificationComplete: Sync = ({ projectId, design }) => ({
  when: actions(
    [ConceptDesigning.modify, { project: projectId }, { design }],
  ),
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "design_complete" }],
  ),
});

/**
 * InitialDesignExit - Sandbox side.
 * Terminates the container after initial design is done.
 */
export const InitialDesignExit: Sync = ({ projectId }) => ({
  when: actions(
    [ConceptDesigning.design, { project: projectId }, {}],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    console.log(`[InitialDesignExit] Triggering exit for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
});

/**
 * ModificationExit - Sandbox side.
 * Terminates the container after modification is done.
 */
export const ModificationExit: Sync = ({ projectId }) => ({
  when: actions(
    [ConceptDesigning.modify, { project: projectId }, {}],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    console.log(`[ModificationExit] Triggering exit for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
});

/**
 * DesignErrorRollback - Sandbox side.
 * Reverts project status when initial design fails.
 */
export const DesignErrorRollback: Sync = ({ projectId, error }) => ({
  when: actions(
    [ConceptDesigning.design, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: ROLLBACK_STATUS }],
    [Sandboxing.exit, {}],
  ),
});

/**
 * DesignModifyErrorRollback - Sandbox side.
 * Reverts project status when design modification fails.
 */
export const DesignModifyErrorRollback: Sync = ({ projectId, error }) => ({
  when: actions(
    [ConceptDesigning.modify, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: ROLLBACK_STATUS }],
    [Sandboxing.exit, {}],
  ),
});

export const syncs = [
  DesignSandboxStartup,
  InitialDesignComplete,
  ModificationComplete,
  InitialDesignExit,
  ModificationExit,
  DesignErrorRollback,
  DesignModifyErrorRollback,
];
