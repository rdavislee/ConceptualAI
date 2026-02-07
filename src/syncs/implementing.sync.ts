import { actions, Sync } from "@engine";
import { ProjectLedger, ConceptDesigning, Implementing, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * ImplementationSandboxStartup - Sandbox side.
 * Triggers implementation when the implementation sandbox starts up.
 */
export const ImplementationSandboxStartup: Sync = ({ projectId, design }) => {
  return {
    when: actions([
      Sandboxing.startImplementing, { projectId }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return [];
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
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "implemented" }],
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
    if (!IS_SANDBOX) return [];
    if (frames.length === 0) return [];
    console.log(`[ImplementationSandboxExit] Triggering exit for project ${frames[0][projectId]}`);
    return frames;
  },
  then: actions(
    [Sandboxing.exit, {}]
  )
});

export const syncs = [
  ImplementationSandboxStartup,
  ImplementationComplete,
  ImplementationSandboxExit
];
