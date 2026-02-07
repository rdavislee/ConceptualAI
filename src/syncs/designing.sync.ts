import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, Sessioning, ConceptDesigning, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK");

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
      if (!IS_SANDBOX) return [];
      console.log(`[DesignSandboxStartup] Matching for project ${frames[0][projectId]}`);

      // Fetch the Plan from DB
      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan: pDoc });

      const newFrames = [];
      for (const f of frames) {
          const planDoc = f[pDoc] as any;
          if (!planDoc || !planDoc.plan) {
              console.warn(`[DesignSandboxStartup] No plan found for project ${f[projectId]}`);
              continue;
          }

          // Optional design lookup
          const designDocs = await ConceptDesigning._getDesign({ project: f[projectId] });
          const designDoc = designDocs.length > 0 ? designDocs[0].design : null;

          newFrames.push({
              ...f,
              [plan]: planDoc.plan,
              [design]: designDoc
          });
      }
      return newFrames;
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
    if (!IS_SANDBOX) return [];
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
    if (!IS_SANDBOX) return [];
    console.log(`[ModificationExit] Triggering exit for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
});

export const syncs = [
  DesignSandboxStartup,
  InitialDesignComplete,
  ModificationComplete,
  InitialDesignExit,
  ModificationExit
];
