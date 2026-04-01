import { actions, Sync } from "@engine";
import {
  Planning,
  ProjectLedger,
  Requesting,
  Sandboxing,
  Sessioning,
} from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK");
const SANDBOX_ID = Deno.env.get("SANDBOX_ID") || "";
const PROJECT_NAME = Deno.env.get("PROJECT_NAME") || "Untitled Project";
const PROJECT_DESCRIPTION = Deno.env.get("PROJECT_DESCRIPTION") || "";
const OWNER_ID = Deno.env.get("OWNER_ID") || "";
const CLARIFICATION_ANSWERS_RAW = Deno.env.get("SANDBOX_CLARIFICATION_ANSWERS");
let CLARIFICATION_ANSWERS: Record<string, string> | null = null;
if (CLARIFICATION_ANSWERS_RAW) {
  try {
    const parsed = JSON.parse(CLARIFICATION_ANSWERS_RAW) as Record<string, string>;
    // Exclude rollbackStatus - it's metadata for error handling, not user clarification
    const filtered = Object.fromEntries(
      Object.entries(parsed).filter(([k]) => k !== "rollbackStatus"),
    );
    CLARIFICATION_ANSWERS = Object.keys(filtered).length > 0 ? filtered : null;
  } catch (error) {
    console.error(
      "[SandboxStartup] Failed to parse SANDBOX_CLARIFICATION_ANSWERS:",
      error,
    );
  }
}

/**
 * SandboxStartup - Triggers planning or modification when the sandbox starts up.
 */
export const SandboxStartup: Sync = (
  { projectId, description, name, ownerId },
) => ({
  when: actions([
    Sandboxing.startPlanning,
    { projectId, name, description, ownerId },
    {},
  ]),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    console.log(
      `[SandboxStartup] Starting planning sandbox for project ${
        frames[0][projectId]
      }`,
    );
    return frames;
  },
  then: actions(
    CLARIFICATION_ANSWERS
      ? [Planning.clarify, {
        project: projectId,
        answers: CLARIFICATION_ANSWERS,
      }]
      : FEEDBACK
      ? [Planning.modify, { project: projectId, feedback: FEEDBACK }]
      : [Planning.initiate, { project: projectId, description, title: name }],
  ),
});

/**
 * InitiateComplete - Updates status when initial planning succeeds.
 */
export const InitiateComplete: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status: "complete", plan }],
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
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "planning_complete",
    }],
  ),
});

/**
 * ModificationComplete - Updates status when plan modification succeeds.
 */
export const ModificationComplete: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.modify, { project: projectId }, { status: "complete", plan }],
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
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "planning_complete",
    }],
  ),
});

/**
 * ClarificationComplete - Updates status when clarification succeeds.
 */
export const ClarificationComplete: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.clarify, { project: projectId }, { status: "complete", plan }],
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
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "planning_complete",
    }],
  ),
});

export const InitiateAutocompleteContinue: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status: "complete", plan }],
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
      status: "designing",
    }],
    [Sandboxing.touch, { sandboxId: SANDBOX_ID }],
    [Sandboxing.startDesigning, {
      projectId,
      name: PROJECT_NAME,
      description: PROJECT_DESCRIPTION,
      ownerId: OWNER_ID,
      feedback: "",
      rollbackStatus: "planning_complete",
    }],
  ),
});

export const ModificationAutocompleteContinue: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.modify, { project: projectId }, { status: "complete", plan }],
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
      status: "designing",
    }],
    [Sandboxing.touch, { sandboxId: SANDBOX_ID }],
    [Sandboxing.startDesigning, {
      projectId,
      name: PROJECT_NAME,
      description: PROJECT_DESCRIPTION,
      ownerId: OWNER_ID,
      feedback: "",
      rollbackStatus: "planning_complete",
    }],
  ),
});

export const ClarificationAutocompleteContinue: Sync = ({ projectId, plan }) => ({
  when: actions(
    [Planning.clarify, { project: projectId }, { status: "complete", plan }],
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
      status: "designing",
    }],
    [Sandboxing.touch, { sandboxId: SANDBOX_ID }],
    [Sandboxing.startDesigning, {
      projectId,
      name: PROJECT_NAME,
      description: PROJECT_DESCRIPTION,
      ownerId: OWNER_ID,
      feedback: "",
      rollbackStatus: "planning_complete",
    }],
  ),
});

/**
 * ClarificationNeedsClarification - Updates status when more clarification is needed.
 */
export const ClarificationNeedsClarification: Sync = (
  { projectId, questions },
) => ({
  when: actions(
    [Planning.clarify, { project: projectId }, {
      status: "needs_clarification",
      questions,
    }],
  ),
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "awaiting_clarification",
    }],
  ),
});

/**
 * InitiateNeedsClarification - Handles clarification requests for initial planning.
 */
export const InitiateNeedsClarification: Sync = (
  { projectId, questions, request },
) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, {
      status: "needs_clarification",
      questions,
    }],
    [Requesting.request, { path: "/projects", method: "POST" }, { request }],
  ),
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "awaiting_clarification",
    }],
  ),
});

/**
 * SandboxExitInitiate - Terminates sandbox after initial planning reaches a result.
 */
export const SandboxExitInitiate: Sync = ({ projectId, status }) => ({
  when: actions(
    [Planning.initiate, { project: projectId }, { status }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    return frames.filter((f) => {
      const s = f[status] as string;
      if (s === "complete") {
        return (f[project] as any)?.autocomplete !== true;
      }
      return s === "needs_clarification" || s === "error";
    });
  },
  then: actions(
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  ),
});

/**
 * SandboxExitModify - Terminates sandbox after modification reaches a result.
 */
export const SandboxExitModify: Sync = ({ projectId, status }) => ({
  when: actions(
    [Planning.modify, { project: projectId }, { status }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    return frames.filter((f) => {
      const s = f[status] as string;
      if (s === "complete") {
        return (f[project] as any)?.autocomplete !== true;
      }
      return s === "error";
    });
  },
  then: actions(
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  ),
});

/**
 * SandboxExitClarify - Terminates sandbox after clarification reaches a result.
 */
export const SandboxExitClarify: Sync = ({ projectId, status }) => ({
  when: actions(
    [Planning.clarify, { project: projectId }, { status }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    const project = Symbol("project");
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project },
    );
    return frames.filter((f) => {
      const s = f[status] as string;
      if (s === "complete") {
        return (f[project] as any)?.autocomplete !== true;
      }
      return s === "needs_clarification" || s === "error";
    });
  },
  then: actions(
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: false,
    }],
    [Sandboxing.exit, {}],
  ),
});

export const UserClarifies: Sync = (
  {
    projectId,
    answers,
    enableAutocomplete,
    token,
    userId,
    owner,
    request,
    path,
    projectName,
    projectDescription,
    geminiKey,
    geminiTier,
  },
) => {
  const doc = Symbol("doc");
  const rollbackStatus = Symbol("rollbackStatus");
  const rollbackAutocomplete = Symbol("rollbackAutocomplete");
  const nextAutocomplete = Symbol("nextAutocomplete");
  const active = Symbol("active");
  return ({
    when: actions([
      Requesting.request,
      {
        path,
        answers,
        enableAutocomplete,
        accessToken: token,
        geminiKey,
        geminiTier,
      },
      { request },
    ]),
    where: async (frames) => {
      if (IS_SANDBOX) return frames.filter(() => false);

      // Parse path
      frames = frames.map((f) => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/clarify$/);
        if (match) {
          return { ...f, [projectId]: match[1] };
        }
        return null;
      }).filter((f) => f !== null) as any;

      // Authenticate
      frames = await frames.query(Sessioning._getUser, { session: token }, {
        user: userId,
      });

      // Do not proceed if this user already has an active sandbox.
      frames = await frames.query(Sandboxing._isActive, { userId }, { active });
      frames = frames.filter((f) => f[active] !== true);

      // Require non-empty credentials and supported tier for sandbox pipeline triggers
      frames = frames.filter((f) => {
        const key = (f[geminiKey] as string) || "";
        const tier = (f[geminiTier] as string) || "";
        return key.trim().length > 0 &&
          (tier === "1" || tier === "2" || tier === "3");
      });

      // Authorization: Check if user owns the project
      frames = await frames.query(ProjectLedger._getOwner, {
        project: projectId,
      }, { owner });

      frames = frames.filter((f) => f[userId] === f[owner]);

      // Get project context for sandbox
      frames = await frames.query(ProjectLedger._getProject, {
        project: projectId,
      }, { project: doc });

      return frames.map((f) => {
        const p = f[doc] as any;
        if (!p || p.error) return null;
        return {
          ...f,
          [projectName]: p.name,
          [projectDescription]: p.description,
          [geminiKey]: f[geminiKey],
          [geminiTier]: f[geminiTier],
          [rollbackStatus]: p.status,
          [rollbackAutocomplete]: p.autocomplete === true,
          [nextAutocomplete]: typeof f[enableAutocomplete] === "boolean"
            ? f[enableAutocomplete]
            : p.autocomplete === true,
        };
      }).filter((f) => f !== null) as any;
    },
    then: actions(
      [Requesting.respond, {
        request,
        project: projectId,
        status: "planning",
      }],
      [ProjectLedger.updateStatus, { project: projectId, status: "planning" }],
      [ProjectLedger.updateAutocomplete, {
        project: projectId,
        autocomplete: nextAutocomplete,
      }],
      [Sandboxing.provision, {
        userId,
        apiKey: geminiKey,
        apiTier: geminiTier,
        projectId,
        name: projectName,
        description: projectDescription,
        mode: "planning",
        answers,
        rollbackStatus,
        rollbackAutocomplete,
      }],
    ),
  });
};

export const UserClarifiesErrorResponse: Sync = (
  { request, path, projectId, error, rollbackStatus, rollbackAutocomplete },
) => ({
  when: actions(
    [Requesting.request, { path }, { request }],
    [Sandboxing.provision, {
      projectId,
      mode: "planning",
      rollbackStatus,
      rollbackAutocomplete,
    }, {
      project: projectId,
      status: "error",
      error,
    }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/clarify`;
    });
  },
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: rollbackStatus,
    }],
    [ProjectLedger.updateAutocomplete, {
      project: projectId,
      autocomplete: rollbackAutocomplete,
    }],
  ),
});

export const ClarificationProcessed: Sync = (
  { projectId, plan, request, path },
) => ({
  when: actions(
    [Planning.clarify, { project: projectId }, { status: "complete", plan }],
    // Match the clarification request
    [Requesting.request, { path }, { request }],
  ),
  where: async (frames) => {
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/clarify`;
    });
  },
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "planning_complete",
    }],
  ),
});

export const ClarificationNeedsMore: Sync = (
  { projectId, questions, request, path },
) => ({
  when: actions(
    [Planning.clarify, { project: projectId }, {
      status: "needs_clarification",
      questions,
    }],
    [Requesting.request, { path }, { request }],
  ),
  where: async (frames) => {
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/clarify`;
    });
  },
  then: actions(
    [ProjectLedger.updateStatus, {
      project: projectId,
      status: "awaiting_clarification",
    }],
  ),
});

export const syncs = [
  SandboxStartup,
  InitiateComplete,
  ModificationComplete,
  ClarificationComplete,
  InitiateAutocompleteContinue,
  ModificationAutocompleteContinue,
  ClarificationAutocompleteContinue,
  ClarificationNeedsClarification,
  InitiateNeedsClarification,
  SandboxExitInitiate,
  SandboxExitModify,
  SandboxExitClarify,
  UserClarifies,
  UserClarifiesErrorResponse,
  ClarificationProcessed,
  ClarificationNeedsMore,
];
