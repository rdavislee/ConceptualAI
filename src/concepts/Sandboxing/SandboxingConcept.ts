import { Db, Collection } from "npm:mongodb";
import { ID, Empty } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

export type User = ID;

const PREFIX = "Sandboxing" + ".";

interface SandboxState {
  _id: ID;
  userId: User;
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

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours
const PLANNING_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours hard cap

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
    const active = await this.sandboxes.find({ status: { $in: ["provisioning", "ready"] } }).toArray();
    const busyPorts = active.map(s => {
      try {
        return parseInt(new URL(s.endpoint).port);
      } catch {
        return 0;
      }
    }).filter(p => !isNaN(p) && p > 0);

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

  private async runDockerWithTimeout(
    args: string[],
    timeoutMs?: number,
  ): Promise<{ success: boolean; stdout: string; stderr: string; timedOut: boolean }> {
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

  /**
   * provision (user: userID, apiKey: String, project: projectID) : (sandbox: sandboxID)
   * requires: no active sandbox for user
   * effects: starts Docker container with apiKey and PROJECT_ID in env, records containerId
   */
  async provision({ userId, apiKey, projectId, name, description, mode, feedback, answers }: {
    userId: ID;
    apiKey: string;
    projectId: ID;
    name: string;
    description: string;
    mode: "planning" | "designing" | "implementing" | "syncgenerating";
    feedback?: string;
    answers?: Record<string, string>;
  }): Promise<{ sandboxId: ID } | { error: string } | PlanningProvisionResult> {
    // Check for active sandbox
    const existing = await this.sandboxes.findOne({
      userId, status: { $in: ["provisioning", "ready"] }
    });

    if (existing) {
      // Verify container still exists
      const verify = new Deno.Command("docker", {
        args: ["inspect", "-f", "{{.State.Running}}", existing.containerId],
      });
      const { stdout, success } = await verify.output();
      const isRunning = new TextDecoder().decode(stdout).trim() === "true";
      if (success && isRunning) {
        if (mode === "planning") {
          return {
            sandboxId: existing._id,
            project: projectId,
            mode: "planning",
            status: "error",
            error: "User already has an active sandbox.",
          };
        }
        return { sandboxId: existing._id };
      } else {
        // Container gone, mark terminal
        await this.sandboxes.updateOne({ _id: existing._id }, { $set: { status: "error" } });
      }
    }

    const sandboxId = freshID();
    const sandboxContainerName = `sandbox-${sandboxId}`;

    // Start container - apiKey passed ONLY here, never stored
    const mongodbUrl = Deno.env.get("MONGODB_URL");
    const dbName = Deno.env.get("DB_NAME");

    console.log(`[Sandboxing] provisioning sandbox for project ${projectId} with context: ${name}`);

    await this.sandboxes.insertOne({
      _id: sandboxId,
      userId,
      containerId: sandboxContainerName,
      endpoint: "ephemeral",
      status: "provisioning",
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    console.log(`[Sandboxing] Env check - GEMINI_MODEL: ${Deno.env.get("GEMINI_MODEL")}, HEADLESS_URL: ${Deno.env.get("HEADLESS_URL")}`);

    const dockerRunArgs = [
      "run",
      ...(mode === "planning" ? ["--rm"] : ["-d"]),
      "--name", sandboxContainerName,
      "-e", `GEMINI_API_KEY=${apiKey}`,
      "-e", `MONGODB_URL=${mongodbUrl}`,
      "-e", `DB_NAME=${dbName}`,
      "-e", `PROJECT_ID=${projectId}`,
      "-e", `PROJECT_NAME=${name}`,
      "-e", `PROJECT_DESCRIPTION=${description}`,
      "-e", `OWNER_ID=${userId}`,
      "-e", `SANDBOX=true`,
      "-e", `SANDBOX_MODE=${mode}`,
      "-e", `SANDBOX_FEEDBACK=${feedback || ""}`,
      "-e", `SANDBOX_CLARIFICATION_ANSWERS=${answers ? JSON.stringify(answers) : ""}`,
      "-e", `GEMINI_MODEL=${Deno.env.get("GEMINI_MODEL") || ""}`,
      "-e", `GEMINI_CONFIG=${Deno.env.get("GEMINI_CONFIG") || ""}`,
      "-e", `HEADLESS_URL=${Deno.env.get("HEADLESS_URL") || ""}`,
      "conceptualai-sandbox:latest",
      "deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-read", "--allow-write", "--allow-sys", "src/main.ts",
    ];

    const dockerResult = await this.runDockerWithTimeout(
      dockerRunArgs,
      mode === "planning" ? PLANNING_TIMEOUT_MS : undefined,
    );
    const { success } = dockerResult;
    const stdoutStr = dockerResult.stdout;
    const errorStr = dockerResult.stderr;

    if (dockerResult.timedOut) {
      // Ensure any lingering container is force-stopped on timeout.
      await new Deno.Command("docker", {
        args: ["stop", sandboxContainerName],
      }).output();
      await this.sandboxes.updateOne(
        { _id: sandboxId },
        { $set: { status: "error", lastActiveAt: new Date() } },
      );
      return {
        sandboxId,
        project: projectId,
        mode: "planning",
        status: "error",
        error: `Planning sandbox timed out after ${Math.floor(PLANNING_TIMEOUT_MS / 60000)} minutes.`,
      };
    }

    if (!success) {
      console.error("[Sandboxing] Failed to start docker container:", errorStr);
      await this.sandboxes.updateOne(
        { _id: sandboxId },
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

    const recordedContainerId = mode === "planning"
      ? sandboxContainerName
      : stdoutStr;
    console.log(`[Sandboxing] Successfully provisioned sandbox container: ${recordedContainerId.substring(0, 12)}`);

    await this.sandboxes.updateOne(
      { _id: sandboxId },
      { $set: { status: "ready", containerId: recordedContainerId, lastActiveAt: new Date() } },
    );

    if (mode === "planning") {
      const planningResult = await this.readPlanningOutcome(projectId);
      await this.sandboxes.updateOne(
        { _id: sandboxId },
        { $set: { status: "terminated", lastActiveAt: new Date() } },
      );
      return {
        sandboxId,
        mode: "planning",
        ...planningResult,
      };
    }

    return { sandboxId };
  }

  /**
   * startPlanning (project: projectID)
   * effects: triggers the planning synchronization within the sandbox.
   */
  async startPlanning({ projectId, name, description, ownerId }: { projectId: ID; name: string; description: string; ownerId: ID }): Promise<Empty> {
    console.log(`[Sandboxing] Starting planning sandbox for project: ${name} (${projectId})`);
    return {};
  }

  /**
   * startDesigning (project: projectID)
   * effects: triggers the design synchronization within the sandbox.
   */
  async startDesigning({ projectId, name, description, ownerId }: { projectId: ID; name: string; description: string; ownerId: ID }): Promise<Empty> {
    console.log(`[Sandboxing] Starting design sandbox for project: ${name} (${projectId})`);
    return {};
  }

  /**
   * startImplementing (project: projectID)
   * effects: triggers the implementation synchronization within the sandbox.
   */
  async startImplementing({ projectId, name, description, ownerId }: { projectId: ID; name: string; description: string; ownerId: ID }): Promise<Empty> {
    console.log(`[Sandboxing] Starting implementation sandbox for project: ${name} (${projectId})`);
    return {};
  }

  /**
   * startSyncGenerating (project: projectID)
   * effects: triggers the sync generation synchronization within the sandbox.
   */
  async startSyncGenerating({ projectId, name, description, ownerId }: { projectId: ID; name: string; description: string; ownerId: ID }): Promise<Empty> {
    console.log(`[Sandboxing] Starting sync generation sandbox for project: ${name} (${projectId})`);
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
  async touch({ sandboxId }: { sandboxId: ID }): Promise<Empty | { error: string }> {
    const result = await this.sandboxes.updateOne(
      { _id: sandboxId },
      { $set: { lastActiveAt: new Date() } }
    );
    if (result.matchedCount === 0) return { error: "Sandbox not found" };
    return {};
  }

  /**
   * teardown (sandbox: sandboxID) : (ok: Flag)
   * requires: sandbox exists
   * effects: stops and removes Docker container, sets status="terminated"
   */
  async teardown({ sandboxId }: { sandboxId: ID }): Promise<Empty | { error: string }> {
    const sandbox = await this.sandboxes.findOne({ _id: sandboxId });
    if (!sandbox) return { error: "Sandbox not found" };

    // Stop container
    const command = new Deno.Command("docker", {
      args: ["stop", `sandbox-${sandboxId}`],
    });
    await command.output();

    await this.sandboxes.updateOne(
      { _id: sandboxId },
      { $set: { status: "terminated" } }
    );

    return {};
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
        { createdAt: { $lt: hardCutoff } }
      ]
    }).toArray();

    for (const sandbox of stale) {
      await this.teardown({ sandboxId: sandbox._id });
    }

    return { reaped: stale.length };
  }

  /**
   * _getEndpoint(user: userID) : (endpoint: String | null)
   */
  async _getEndpoint({ userId }: { userId: User }): Promise<Array<{ endpoint: string | null }>> {
    const sandbox = await this.sandboxes.findOne({
      userId, status: "ready"
    });
    return [{ endpoint: sandbox?.endpoint ?? null }];
  }

  /**
   * _isActive(user: userID) : (active: Flag)
   */
  async _isActive({ userId }: { userId: User }): Promise<Array<{ active: boolean }>> {
    const sandbox = await this.sandboxes.findOne({
      userId, status: { $in: ["provisioning", "ready"] }
    });
    return [{ active: !!sandbox }];
  }
}
