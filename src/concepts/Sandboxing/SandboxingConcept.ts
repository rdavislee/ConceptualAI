import { Collection, Db } from "npm:mongodb";
import { Empty, ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

export type User = ID;

const PREFIX = "Sandboxing" + ".";

interface SandboxState {
  _id: ID;
  userId: User;
  projectId?: ID;
  containerId: string;
  endpoint: string;
  status: "provisioning" | "ready" | "idle" | "error" | "terminated";
  createdAt: Date;
  lastActiveAt: Date;
}

interface PlanningOutcomeDoc {
  _id: ID;
  status: "processing" | "needs_clarification" | "complete" | "error";
  plan?: Record<string, unknown>;
  questions?: string[];
}

interface DesignOutcomeDoc {
  _id: ID;
  [key: string]: unknown;
}

interface ImplementationOutcomeDoc {
  _id: ID;
  implementations?: Record<string, unknown>;
}

interface SyncGenerationOutcomeDoc {
  _id: ID;
  syncs?: unknown[];
  apiDefinition?: Record<string, unknown>;
  endpointBundles?: unknown[];
}

interface AssemblyOutcomeDoc {
  _id: ID;
  downloadUrl?: string;
}

interface FrontendOutcomeDoc {
  _id: ID;
  status?: "processing" | "complete" | "error";
  downloadUrl?: string;
  logs?: string[];
}

type PlanningProvisionResult =
  | {
    sandboxId: ID;
    project: ID;
    mode: "planning";
    status: "complete";
    plan: Record<string, unknown>;
  }
  | {
    sandboxId: ID;
    project: ID;
    mode: "planning";
    status: "needs_clarification";
    questions: string[];
  }
  | {
    sandboxId: ID;
    project: ID;
    mode: "planning";
    status: "error";
    error: string;
  };

type DesigningProvisionResult = {
  sandboxId: ID;
  project: ID;
  mode: "designing";
  status: "complete";
  design: Record<string, unknown>;
};

type ImplementingProvisionResult = {
  sandboxId: ID;
  project: ID;
  mode: "implementing";
  status: "complete";
  implementations: Record<string, unknown>;
};

type SyncGeneratingProvisionResult = {
  sandboxId: ID;
  project: ID;
  mode: "syncgenerating";
  status: "complete";
  syncs: unknown[];
  apiDefinition: Record<string, unknown>;
  endpointBundles: unknown[];
};

type AssemblingProvisionResult = {
  sandboxId: ID;
  project: ID;
  mode: "syncgenerating";
  status: "complete";
  downloadUrl: string;
};

type BuildProvisionResult = {
  sandboxId: ID;
  project: ID;
  mode: "syncgenerating";
  status: "complete";
  backendDownloadUrl: string;
  frontendDownloadUrl: string;
};

type PlanningOutcome =
  | {
    project: ID;
    status: "complete";
    plan: Record<string, unknown>;
  }
  | {
    project: ID;
    status: "needs_clarification";
    questions: string[];
  }
  | {
    project: ID;
    status: "error";
    error: string;
  };

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours
const SANDBOX_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours hard cap for all sandbox modes
const SANDBOX_IMAGE_BUILD_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const ASSEMBLING_MARKER = "__ASSEMBLING__";
const BUILD_MARKER = "__BUILD__";
const MAX_CONCURRENT_SANDBOXES = parseInt(
  Deno.env.get("MAX_CONCURRENT_SANDBOXES") ?? "20",
  10,
);

/**
 * @concept Sandboxing
 * @purpose Provide isolated compute environments using Docker containers.
 */
export default class SandboxingConcept {
  sandboxes: Collection<SandboxState>;

  constructor(private readonly db: Db) {
    this.sandboxes = this.db.collection<SandboxState>(PREFIX + "sandboxes");
  }

  private async findAvailablePort(): Promise<number> {
    const active = await this.sandboxes.find({
      status: { $in: ["provisioning", "ready"] },
    }).toArray();
    const busyPorts = active.map((s) => {
      try {
        return parseInt(new URL(s.endpoint).port);
      } catch {
        return 0;
      }
    }).filter((p) => !isNaN(p) && p > 0);

    for (let port = 10001; port < 11000; port++) {
      if (!busyPorts.includes(port)) return port;
    }
    throw new Error("No available ports");
  }

  private async readPlanningOutcome(projectId: ID): Promise<PlanningOutcome> {
    const plans = this.db.collection<PlanningOutcomeDoc>("Planning.plans");
    const doc = await plans.findOne({ _id: projectId });
    if (!doc) {
      return {
        project: projectId,
        status: "error",
        error: "Planning result was not written by sandbox.",
      };
    }

    if (doc.status === "complete") {
      if (!doc.plan) {
        return {
          project: projectId,
          status: "error",
          error: "Planning completed but plan payload is missing.",
        };
      }
      return {
        project: projectId,
        status: "complete",
        plan: doc.plan,
      };
    }

    if (doc.status === "needs_clarification") {
      return {
        project: projectId,
        status: "needs_clarification",
        questions: doc.questions ?? [],
      };
    }

    return {
      project: projectId,
      status: "error",
      error: `Planning ended with status '${doc.status}'.`,
    };
  }

  private async readDesignOutcome(
    projectId: ID,
  ): Promise<{ design: Record<string, unknown> } | { error: string }> {
    const designs = this.db.collection<DesignOutcomeDoc>(
      "ConceptDesigning.designs",
    );
    const doc = await designs.findOne({ _id: projectId });
    if (!doc) return { error: "Design result was not written by sandbox." };
    return { design: doc as unknown as Record<string, unknown> };
  }

  private async readImplementationOutcome(
    projectId: ID,
  ): Promise<{ implementations: Record<string, unknown> } | { error: string }> {
    const implJobs = this.db.collection<ImplementationOutcomeDoc>(
      "Implementing.implJobs",
    );
    const doc = await implJobs.findOne({ _id: projectId });
    if (!doc || !doc.implementations) {
      return { error: "Implementation result was not written by sandbox." };
    }
    return { implementations: doc.implementations };
  }

  private async readSyncGenerationOutcome(projectId: ID): Promise<
    {
      syncs: unknown[];
      apiDefinition: Record<string, unknown>;
      endpointBundles: unknown[];
    } | { error: string }
  > {
    const syncJobs = this.db.collection<SyncGenerationOutcomeDoc>(
      "SyncGenerating.syncJobs",
    );
    const doc = await syncJobs.findOne({ _id: projectId });
    if (!doc || !doc.syncs || !doc.apiDefinition || !doc.endpointBundles) {
      return { error: "Sync generation result was not written by sandbox." };
    }
    return {
      syncs: doc.syncs,
      apiDefinition: doc.apiDefinition,
      endpointBundles: doc.endpointBundles,
    };
  }

  private async readAssemblyOutcome(
    projectId: ID,
  ): Promise<{ downloadUrl: string } | { error: string }> {
    const assemblies = this.db.collection<AssemblyOutcomeDoc>(
      "Assembling.assemblies",
    );
    const doc = await assemblies.findOne({ _id: projectId });
    if (!doc || !doc.downloadUrl) {
      return { error: "Assembly result was not written by sandbox." };
    }
    return { downloadUrl: doc.downloadUrl };
  }

  private async readFrontendOutcome(
    projectId: ID,
  ): Promise<{ downloadUrl: string } | { error: string }> {
    const jobs = this.db.collection<FrontendOutcomeDoc>(
      "FrontendGenerating.jobs",
    );
    const doc = await jobs.findOne({ _id: projectId });
    if (!doc) {
      return {
        error: "Frontend generation result was not written by sandbox.",
      };
    }
    if (doc.status === "error") {
      const detail = doc.logs && doc.logs.length > 0
        ? ` ${doc.logs[doc.logs.length - 1]}`
        : "";
      return { error: `Frontend generation failed.${detail}` };
    }
    if (doc.status !== "complete" || !doc.downloadUrl) {
      return { error: "Frontend generation did not complete in sandbox." };
    }
    return { downloadUrl: doc.downloadUrl };
  }

  private async readBuildOutcome(
    projectId: ID,
  ): Promise<
    { backendDownloadUrl: string; frontendDownloadUrl: string } | {
      error: string;
    }
  > {
    const assembly = await this.readAssemblyOutcome(projectId);
    if ("error" in assembly) return { error: assembly.error };

    const frontend = await this.readFrontendOutcome(projectId);
    if ("error" in frontend) return { error: frontend.error };

    return {
      backendDownloadUrl: assembly.downloadUrl,
      frontendDownloadUrl: frontend.downloadUrl,
    };
  }

  private async markSandboxTerminated(sandboxId: ID): Promise<void> {
    await this.sandboxes.updateOne(
      { _id: sandboxId },
      { $set: { status: "terminated", lastActiveAt: new Date() } },
    );
  }

  private async runDockerWithTimeout(
    args: string[],
    timeoutMs?: number,
  ): Promise<
    { success: boolean; stdout: string; stderr: string; timedOut: boolean }
  > {
    const command = new Deno.Command("docker", {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    if (timeoutMs === undefined) {
      const { stdout, stderr, success } = await command.output();
      return {
        success,
        stdout: new TextDecoder().decode(stdout).trim(),
        stderr: new TextDecoder().decode(stderr).trim(),
        timedOut: false,
      };
    }

    const process = command.spawn();
    const outputPromise = process.output();
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs)
    );
    const raced = await Promise.race([outputPromise, timeoutPromise]);

    if (raced === null) {
      try {
        process.kill("SIGTERM");
      } catch {
        // ignore kill errors on already-exited processes
      }
      return {
        success: false,
        stdout: "",
        stderr: `docker run exceeded timeout (${timeoutMs}ms)`,
        timedOut: true,
      };
    }

    return {
      success: raced.success,
      stdout: new TextDecoder().decode(raced.stdout).trim(),
      stderr: new TextDecoder().decode(raced.stderr).trim(),
      timedOut: false,
    };
  }

  private async rebuildSandboxImageIfNeeded(
    reason: string,
  ): Promise<{ success: boolean; error?: string }> {
    console.warn(`[Sandboxing] Rebuilding sandbox image because: ${reason}`);
    const buildResult = await this.runDockerWithTimeout(
      [
        "build",
        "-f",
        "Dockerfile.sandbox",
        "-t",
        "conceptualai-sandbox:latest",
        ".",
      ],
      SANDBOX_IMAGE_BUILD_TIMEOUT_MS,
    );
    if (!buildResult.success) {
      const detail = buildResult.stderr || buildResult.stdout ||
        "unknown docker build failure";
      return {
        success: false,
        error: `Failed to rebuild sandbox image: ${detail}`,
      };
    }
    return { success: true };
  }

  /**
   * provision (user: userID, apiKey: String, project: projectID) : (sandbox: sandboxID)
   * requires: no active sandbox for user
   * effects: starts Docker container with apiKey and PROJECT_ID in env, records containerId
   */
  async provision(
    {
      userId,
      apiKey,
      apiTier,
      projectId,
      name,
      description,
      mode,
      feedback,
      answers,
      rollbackStatus,
    }: {
      userId: ID;
      apiKey: string;
      apiTier: string;
      projectId: ID;
      name: string;
      description: string;
      mode: "planning" | "designing" | "implementing" | "syncgenerating";
      feedback?: string;
      answers?: Record<string, unknown>;
      rollbackStatus?: string;
    },
  ): Promise<
    | { sandboxId: ID }
    | { error: string }
    | PlanningProvisionResult
    | DesigningProvisionResult
    | ImplementingProvisionResult
    | SyncGeneratingProvisionResult
    | AssemblingProvisionResult
    | BuildProvisionResult
  > {
    // Check for active sandbox
    const existing = await this.sandboxes.findOne({
      userId,
      status: { $in: ["provisioning", "ready"] },
    });

    if (existing) {
      // Verify container still exists
      const verify = new Deno.Command("docker", {
        args: ["inspect", "-f", "{{.State.Running}}", existing.containerId],
      });
      const { stdout, success } = await verify.output();
      const isRunning = new TextDecoder().decode(stdout).trim() === "true";
      if (success && isRunning) {
        const isBuildRetry = mode === "syncgenerating" &&
          (feedback || "").startsWith(BUILD_MARKER);
        if (isBuildRetry) {
          console.warn(
            `[Sandboxing] Existing active sandbox ${existing.containerId} found; replacing it for build retry.`,
          );
          const stopResult = await this.runDockerWithTimeout([
            "stop",
            existing.containerId,
          ], 30_000);
          if (!stopResult.success) {
            return {
              error:
                `Failed to stop previous active sandbox (${existing.containerId}): ${
                  stopResult.stderr || stopResult.stdout
                }`,
            };
          }
          await this.sandboxes.updateOne(
            { _id: existing._id },
            { $set: { status: "terminated", lastActiveAt: new Date() } },
          );
        } else {
          const activeMessage =
            "User already has an active sandbox. Wait for it to finish, then retry.";
          if (mode === "planning") {
            return {
              sandboxId: existing._id,
              project: projectId,
              mode: "planning",
              status: "error",
              error: activeMessage,
            };
          }
          return { error: activeMessage };
        }
      } else {
        // Container gone, mark terminal
        await this.sandboxes.updateOne({ _id: existing._id }, {
          $set: { status: "error" },
        });
      }
    }

    // Capacity check: reject if too many sandboxes are already running
    const activeCount = await this.sandboxes.countDocuments({
      status: { $in: ["provisioning", "ready"] },
    });
    if (activeCount >= MAX_CONCURRENT_SANDBOXES) {
      const capacityMsg =
        `Server is at capacity (${MAX_CONCURRENT_SANDBOXES} concurrent sandboxes). Please try again in a few minutes.`;
      if (mode === "planning") {
        return {
          sandboxId: "" as ID,
          project: projectId,
          mode: "planning",
          status: "error",
          error: capacityMsg,
        };
      }
      return { error: capacityMsg };
    }

    const sandboxId = freshID();
    const sandboxContainerName = `sandbox-${sandboxId}`;

    // Start container - apiKey passed ONLY here, never stored
    // When running in Docker, localhost/127.0.0.1 refers to the container, not the host.
    // Replace with host.docker.internal so the container can reach the host's MongoDB.
    let mongodbUrl = Deno.env.get("MONGODB_URL") ?? "";
    if (
      mongodbUrl &&
      (mongodbUrl.includes("localhost") || mongodbUrl.includes("127.0.0.1"))
    ) {
      mongodbUrl = mongodbUrl
        .replace(/localhost/g, "host.docker.internal")
        .replace(/127\.0\.0\.1/g, "host.docker.internal");
    }
    const dbName = Deno.env.get("DB_NAME");

    console.log(
      `[Sandboxing] provisioning sandbox for project ${projectId} with context: ${name}`,
    );

    await this.sandboxes.insertOne({
      _id: sandboxId,
      userId,
      projectId: projectId,
      containerId: sandboxContainerName,
      endpoint: "ephemeral",
      status: "provisioning",
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    console.log(
      `[Sandboxing] Env check - GEMINI_MODEL: ${
        Deno.env.get("GEMINI_MODEL")
      }, HEADLESS_URL: ${Deno.env.get("HEADLESS_URL")}`,
    );

    const sandboxMeta: Record<string, string> = {};
    if (answers) {
      for (const [k, v] of Object.entries(answers)) {
        if (typeof v === "string") sandboxMeta[k] = v;
      }
    }
    if (rollbackStatus) sandboxMeta.rollbackStatus = rollbackStatus;

    const dockerRunArgs = [
      "run",
      "--rm",
      "--name",
      sandboxContainerName,
      "-e",
      `GEMINI_API_KEY=${apiKey}`,
      "-e",
      `GEMINI_TIER=${apiTier}`,
      "-e",
      `MONGODB_URL=${mongodbUrl}`,
      "-e",
      `DB_NAME=${dbName}`,
      "-e",
      `PROJECT_ID=${projectId}`,
      "-e",
      `PROJECT_NAME=${name}`,
      "-e",
      `PROJECT_DESCRIPTION=${description}`,
      "-e",
      `OWNER_ID=${userId}`,
      "-e",
      `SANDBOX=true`,
      "-e",
      `SANDBOX_MODE=${mode}`,
      "-e",
      `SANDBOX_FEEDBACK=${feedback || ""}`,
      "-e",
      `SANDBOX_CLARIFICATION_ANSWERS=${
        Object.keys(sandboxMeta).length > 0 ? JSON.stringify(sandboxMeta) : ""
      }`,
      "-e",
      `GEMINI_MODEL=${Deno.env.get("GEMINI_MODEL") || ""}`,
      "-e",
      `GEMINI_CONFIG=${Deno.env.get("GEMINI_CONFIG") || ""}`,
      "-e",
      `HEADLESS_URL=${Deno.env.get("HEADLESS_URL") || ""}`,
      "conceptualai-sandbox:latest",
      "deno",
      "run",
      "--allow-net",
      "--allow-env",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      "--allow-sys",
      "src/main.ts",
    ];

    let dockerResult = await this.runDockerWithTimeout(
      dockerRunArgs,
      SANDBOX_TIMEOUT_MS,
    );
    let success = dockerResult.success;
    let stdoutStr = dockerResult.stdout;
    let errorStr = dockerResult.stderr;

    if (!success) {
      const missingImage =
        /unable to find image|no such image|pull access denied|repository does not exist|not found/i
          .test(
            `${stdoutStr}\n${errorStr}`,
          );
      if (missingImage) {
        const rebuilt = await this.rebuildSandboxImageIfNeeded(
          "sandbox image missing",
        );
        if (!rebuilt.success) {
          errorStr = rebuilt.error || "Failed to rebuild sandbox image";
        } else {
          dockerResult = await this.runDockerWithTimeout(
            dockerRunArgs,
            SANDBOX_TIMEOUT_MS,
          );
          success = dockerResult.success;
          stdoutStr = dockerResult.stdout;
          errorStr = dockerResult.stderr;
        }
      }
    }

    if (dockerResult.timedOut) {
      // Ensure any lingering container is force-stopped on timeout.
      await new Deno.Command("docker", {
        args: ["stop", sandboxContainerName],
      }).output();
      // Do not overwrite a sandbox that was already terminated by another flow
      // (e.g. project revert while provision is still unwinding).
      await this.sandboxes.updateOne(
        { _id: sandboxId, status: { $ne: "terminated" } },
        { $set: { status: "error", lastActiveAt: new Date() } },
      );
      if (mode === "planning") {
        return {
          sandboxId,
          project: projectId,
          mode: "planning",
          status: "error",
          error: `Planning sandbox timed out after ${
            Math.floor(SANDBOX_TIMEOUT_MS / 60000)
          } minutes.`,
        };
      }
      return {
        error: `${mode} sandbox timed out after ${
          Math.floor(SANDBOX_TIMEOUT_MS / 60000)
        } minutes.`,
      };
    }

    if (!success) {
      console.error("[Sandboxing] Failed to start docker container:", errorStr);
      await this.sandboxes.updateOne(
        { _id: sandboxId, status: { $ne: "terminated" } },
        { $set: { status: "error", lastActiveAt: new Date() } },
      );
      if (mode === "planning") {
        return {
          sandboxId,
          project: projectId,
          mode: "planning",
          status: "error",
          error: "Failed to run planning sandbox: " + errorStr,
        };
      }
      return { error: "Failed to start sandbox: " + errorStr };
    }

    const recordedContainerId = sandboxContainerName;
    console.log(
      `[Sandboxing] Successfully provisioned sandbox container: ${
        recordedContainerId.substring(0, 12)
      }`,
    );

    await this.sandboxes.updateOne(
      { _id: sandboxId, status: { $ne: "terminated" } },
      {
        $set: {
          status: "ready",
          containerId: recordedContainerId,
          lastActiveAt: new Date(),
        },
      },
    );

    if (mode === "planning") {
      const planningResult = await this.readPlanningOutcome(projectId);
      await this.markSandboxTerminated(sandboxId);
      return {
        sandboxId,
        mode: "planning",
        ...planningResult,
      };
    }

    if (mode === "designing") {
      const designResult = await this.readDesignOutcome(projectId);
      await this.markSandboxTerminated(sandboxId);
      if ("error" in designResult) return { error: designResult.error };
      return {
        sandboxId,
        project: projectId,
        mode: "designing",
        status: "complete",
        design: designResult.design,
      };
    }

    if (mode === "implementing") {
      const implResult = await this.readImplementationOutcome(projectId);
      await this.markSandboxTerminated(sandboxId);
      if ("error" in implResult) return { error: implResult.error };
      return {
        sandboxId,
        project: projectId,
        mode: "implementing",
        status: "complete",
        implementations: implResult.implementations,
      };
    }

    if (mode === "syncgenerating") {
      if ((feedback || "").startsWith(ASSEMBLING_MARKER)) {
        const assemblyResult = await this.readAssemblyOutcome(projectId);
        await this.markSandboxTerminated(sandboxId);
        if ("error" in assemblyResult) return { error: assemblyResult.error };
        return {
          sandboxId,
          project: projectId,
          mode: "syncgenerating",
          status: "complete",
          downloadUrl: assemblyResult.downloadUrl,
        };
      }

      if ((feedback || "").startsWith(BUILD_MARKER)) {
        const buildResult = await this.readBuildOutcome(projectId);
        await this.markSandboxTerminated(sandboxId);
        if ("error" in buildResult) return { error: buildResult.error };
        return {
          sandboxId,
          project: projectId,
          mode: "syncgenerating",
          status: "complete",
          backendDownloadUrl: buildResult.backendDownloadUrl,
          frontendDownloadUrl: buildResult.frontendDownloadUrl,
        };
      }

      const syncResult = await this.readSyncGenerationOutcome(projectId);
      await this.markSandboxTerminated(sandboxId);
      if ("error" in syncResult) return { error: syncResult.error };
      return {
        sandboxId,
        project: projectId,
        mode: "syncgenerating",
        status: "complete",
        syncs: syncResult.syncs,
        apiDefinition: syncResult.apiDefinition,
        endpointBundles: syncResult.endpointBundles,
      };
    }

    await this.markSandboxTerminated(sandboxId);
    return { sandboxId };
  }

  /**
   * startPlanning (project: projectID)
   * effects: triggers the planning synchronization within the sandbox.
   */
  async startPlanning(
    { projectId, name, description, ownerId }: {
      projectId: ID;
      name: string;
      description: string;
      ownerId: ID;
    },
  ): Promise<Empty> {
    console.log(
      `[Sandboxing] Starting planning sandbox for project: ${name} (${projectId})`,
    );
    return {};
  }

  /**
   * startDesigning (project: projectID)
   * effects: triggers the design synchronization within the sandbox.
   */
  async startDesigning(
    { projectId, name, description, ownerId }: {
      projectId: ID;
      name: string;
      description: string;
      ownerId: ID;
    },
  ): Promise<Empty> {
    console.log(
      `[Sandboxing] Starting design sandbox for project: ${name} (${projectId})`,
    );
    return {};
  }

  /**
   * startImplementing (project: projectID)
   * effects: triggers the implementation synchronization within the sandbox.
   */
  async startImplementing(
    { projectId, name, description, ownerId }: {
      projectId: ID;
      name: string;
      description: string;
      ownerId: ID;
    },
  ): Promise<Empty> {
    console.log(
      `[Sandboxing] Starting implementation sandbox for project: ${name} (${projectId})`,
    );
    return {};
  }

  /**
   * startSyncGenerating (project: projectID)
   * effects: triggers the sync generation synchronization within the sandbox.
   */
  async startSyncGenerating(
    { projectId, name, description, ownerId }: {
      projectId: ID;
      name: string;
      description: string;
      ownerId: ID;
    },
  ): Promise<Empty> {
    console.log(
      `[Sandboxing] Starting sync generation sandbox for project: ${name} (${projectId})`,
    );
    return {};
  }

  /**
   * exit ()
   * effects: terminates the current process (called from within sandbox).
   */
  async exit(): Promise<Empty> {
    console.log("[Sandboxing] Sandbox process complete. Exiting...");
    setTimeout(() => Deno.exit(0), 100);
    return {};
  }

  /**
   * touch (sandbox: sandboxID) : (ok: Flag)
   * requires: sandbox exists and is active
   * effects: updates lastActiveAt timestamp
   */
  async touch(
    { sandboxId }: { sandboxId: ID },
  ): Promise<Empty | { error: string }> {
    const result = await this.sandboxes.updateOne(
      { _id: sandboxId },
      { $set: { lastActiveAt: new Date() } },
    );
    if (result.matchedCount === 0) return { error: "Sandbox not found" };
    return {};
  }

  /**
   * teardown (sandbox: sandboxID) : (ok: Flag)
   * requires: sandbox exists
   * effects: stops and removes Docker container, sets status="terminated"
   */
  async teardown(
    { sandboxId }: { sandboxId: ID },
  ): Promise<Empty | { error: string }> {
    const sandbox = await this.sandboxes.findOne({ _id: sandboxId });
    if (!sandbox) return { error: "Sandbox not found" };

    // Stop container
    const command = new Deno.Command("docker", {
      args: ["stop", `sandbox-${sandboxId}`],
    });
    await command.output();

    await this.sandboxes.updateOne(
      { _id: sandboxId },
      { $set: { status: "terminated" } },
    );

    return {};
  }

  /**
   * teardownProject (project: projectID) : (terminated: Number)
   * effects: stops and marks all non-terminated sandboxes for a project as terminated
   */
  async teardownProject(
    { projectId }: { projectId: ID },
  ): Promise<{ terminated: number }> {
    const projectSandboxes = await this.sandboxes.find({
      projectId,
      status: { $ne: "terminated" },
    }).toArray();

    if (projectSandboxes.length === 0) return { terminated: 0 };

    for (const sandbox of projectSandboxes) {
      try {
        const stopResult = await this.runDockerWithTimeout(
          ["stop", sandbox.containerId],
          30_000,
        );
        if (!stopResult.success) {
          const detail = stopResult.stderr || stopResult.stdout ||
            "unknown docker stop failure";
          console.warn(
            `[Sandboxing] Failed to stop sandbox ${sandbox.containerId} for project ${projectId}: ${detail}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Sandboxing] Failed to stop sandbox ${sandbox.containerId} for project ${projectId}: ${message}`,
        );
      }
    }

    await this.sandboxes.updateMany(
      { _id: { $in: projectSandboxes.map((s) => s._id) } },
      { $set: { status: "terminated", lastActiveAt: new Date() } },
    );

    return { terminated: projectSandboxes.length };
  }

  /**
   * reap () : (reaped: Number)
   * effects: finds all sandboxes with lastActiveAt older than IDLE_TIMEOUT, calls teardown
   */
  async reap(): Promise<{ reaped: number }> {
    const cutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);
    const hardCutoff = new Date(Date.now() - MAX_LIFETIME_MS);

    const stale = await this.sandboxes.find({
      status: { $in: ["ready", "idle"] },
      $or: [
        { lastActiveAt: { $lt: cutoff } },
        { createdAt: { $lt: hardCutoff } },
      ],
    }).toArray();

    for (const sandbox of stale) {
      await this.teardown({ sandboxId: sandbox._id });
    }

    return { reaped: stale.length };
  }

  /**
   * _getEndpoint(user: userID) : (endpoint: String | null)
   */
  async _getEndpoint(
    { userId }: { userId: User },
  ): Promise<Array<{ endpoint: string | null }>> {
    const sandbox = await this.sandboxes.findOne({
      userId,
      status: "ready",
    });
    return [{ endpoint: sandbox?.endpoint ?? null }];
  }

  /**
   * _isActive(user: userID) : (active: Flag)
   */
  async _isActive(
    { userId }: { userId: User },
  ): Promise<Array<{ active: boolean }>> {
    const sandbox = await this.sandboxes.findOne({
      userId,
      status: { $in: ["provisioning", "ready"] },
    });
    return [{ active: !!sandbox }];
  }
}
