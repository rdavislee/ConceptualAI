import { actions, Sync } from "@engine";
import { ProjectLedger, Planning, Requesting, Sessioning, ConceptDesigning, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK");
const SANDBOX_ID = Deno.env.get("SANDBOX_ID") || "";
const PROJECT_NAME = Deno.env.get("PROJECT_NAME") || "Untitled Project";
const PROJECT_DESCRIPTION = Deno.env.get("PROJECT_DESCRIPTION") || "";
const OWNER_ID = Deno.env.get("OWNER_ID") || "";

/**
 * DesignSandboxStartup - Sandbox side.
 * Triggers the initial design pass when the design sandbox starts up.
 */
export const DesignSandboxStartup: Sync = (
  { projectId, description, name, ownerId, plan, design, feedback },
) => {
  const pDoc = Symbol("pDoc");
  return {
    when: actions([
      Sandboxing.startDesigning,
      { projectId, name, description, ownerId, feedback },
      {},
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      frames = frames.filter((f) => String(f[feedback] ?? FEEDBACK ?? "") === "");
      if (frames.length === 0) return frames;
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
      [ConceptDesigning.design, { project: projectId, plan }]
    ),
  };
};

/**
 * DesignModifySandboxStartup - Sandbox side.
 * Triggers a design modification pass when feedback is present.
 */
export const DesignModifySandboxStartup: Sync = (
  { projectId, description, name, ownerId, plan, design, feedback },
) => {
  const pDoc = Symbol("pDoc");
  const effectiveFeedback = Symbol("effectiveFeedback");
  return {
    when: actions([
      Sandboxing.startDesigning,
      { projectId, name, description, ownerId, feedback },
      {},
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      frames = frames.map((f) => ({
        ...f,
        [effectiveFeedback]: String(f[feedback] ?? FEEDBACK ?? ""),
      })).filter((f) => String(f[effectiveFeedback] ?? "") !== "") as any;
      if (frames.length === 0) return frames;
      console.log(
        `[DesignModifySandboxStartup] Matching for project ${frames[0][projectId]}`,
      );

      frames = await frames.query(Planning._getPlan, { project: projectId }, {
        plan: pDoc,
      });

      const newFrames: any[] = [];
      for (const f of frames) {
        const planDoc = f[pDoc] as any;
        if (!planDoc || !planDoc.plan) {
          console.warn(
            `[DesignModifySandboxStartup] No plan found for project ${f[projectId]}`,
          );
          continue;
        }

        const designDocs = await ConceptDesigning._getDesign({
          project: f[projectId] as any,
        });
        const designDoc = designDocs.length > 0 ? designDocs[0].design : null;

        newFrames.push({
          ...f,
          [plan]: planDoc.plan,
          [design]: designDoc,
        });
      }
      const out = frames.filter(() => false);
      out.push(...newFrames as any[]);
      return out;
    },
    then: actions(
      [ConceptDesigning.modify, {
        project: projectId,
        plan,
        feedback: effectiveFeedback,
      }],
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
    [ProjectLedger.updateStatus, { project: projectId, status: "design_complete" }],
  ),
});

export const InitialDesignAutocompleteContinue: Sync = ({ projectId, design }) => ({
  when: actions(
    [ConceptDesigning.design, { project: projectId }, { design }],
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
    [ProjectLedger.updateStatus, { project: projectId, status: "implementing" }],
    [Sandboxing.touch, { sandboxId: SANDBOX_ID }],
    [Sandboxing.startImplementing, {
      projectId,
      name: PROJECT_NAME,
      description: PROJECT_DESCRIPTION,
      ownerId: OWNER_ID,
      rollbackStatus: "design_complete",
    }],
  ),
});

export const ModificationAutocompleteContinue: Sync = ({ projectId, design }) => ({
  when: actions(
    [ConceptDesigning.modify, { project: projectId }, { design }],
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
    [ProjectLedger.updateStatus, { project: projectId, status: "implementing" }],
    [Sandboxing.touch, { sandboxId: SANDBOX_ID }],
    [Sandboxing.startImplementing, {
      projectId,
      name: PROJECT_NAME,
      description: PROJECT_DESCRIPTION,
      ownerId: OWNER_ID,
      rollbackStatus: "design_complete",
    }],
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
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    frames = frames.filter((f) => (f[project] as any)?.autocomplete !== true);
    if (frames.length === 0) return frames;
    console.log(`[InitialDesignExit] Triggering exit for project ${frames[0][projectId]}`);
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
 * ModificationExit - Sandbox side.
 * Terminates the container after modification is done.
 */
export const ModificationExit: Sync = ({ projectId }) => ({
  when: actions(
    [ConceptDesigning.modify, { project: projectId }, {}],
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
    if (frames.length === 0) return frames;
    console.log(`[ModificationExit] Triggering exit for project ${frames[0][projectId]}`);
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
 * DesignErrorRollback - Sandbox side.
 * Reverts project status when initial design fails.
 */
export const DesignErrorRollback: Sync = (
  { projectId, error, rollbackStatus, effectiveRollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startDesigning, { projectId, rollbackStatus }, {}],
    [ConceptDesigning.design, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    return frames.map((f) => ({
      ...f,
      [effectiveRollbackStatus]:
        typeof f[rollbackStatus] === "string" && String(f[rollbackStatus]).length > 0
          ? f[rollbackStatus]
          : "planning_complete",
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

/**
 * DesignModifyErrorRollback - Sandbox side.
 * Reverts project status when design modification fails.
 */
export const DesignModifyErrorRollback: Sync = (
  { projectId, error, rollbackStatus, effectiveRollbackStatus },
) => ({
  when: actions(
    [Sandboxing.startDesigning, { projectId, rollbackStatus }, {}],
    [ConceptDesigning.modify, { project: projectId }, { error }],
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
  DesignSandboxStartup,
  DesignModifySandboxStartup,
  InitialDesignComplete,
  ModificationComplete,
  InitialDesignAutocompleteContinue,
  ModificationAutocompleteContinue,
  InitialDesignExit,
  ModificationExit,
  DesignErrorRollback,
  DesignModifyErrorRollback,
];
