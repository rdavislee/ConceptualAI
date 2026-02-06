import { Db, Collection } from "npm:mongodb";
import { ID, Empty } from "@utils/types.ts";

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

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours

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

  /**
   * provision (user: userID, apiKey: String, project: projectID) : (sandbox: sandboxID)
   * requires: no active sandbox for user
   * effects: starts Docker container with apiKey and PROJECT_ID in env, records containerId
   */
  async provision({ userId, apiKey, projectId, name, description }: {
    userId: ID;
    apiKey: string;
    projectId: ID;
    name: string;
    description: string;
  }): Promise<{ sandboxId: ID } | { error: string }> {
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
        return { sandboxId: existing._id };
      } else {
        // Container gone, mark terminal
        await this.sandboxes.updateOne({ _id: existing._id }, { $set: { status: "error" } });
      }
    }

    const sandboxId = crypto.randomUUID();

    // Start container - apiKey passed ONLY here, never stored
    const mongodbUrl = Deno.env.get("MONGODB_URL");
    const dbName = Deno.env.get("DB_NAME");

    console.log(`[Sandboxing] provisioning sandbox for project ${projectId} with context: ${name}`);

    const command = new Deno.Command("docker", {
      args: [
        "run", "-d",
        "--name", `sandbox-${sandboxId}`,
        "-e", `GEMINI_API_KEY=${apiKey}`,
        "-e", `MONGODB_URL=${mongodbUrl}`,
        "-e", `DB_NAME=${dbName}`,
        "-e", `PROJECT_ID=${projectId}`,
        "-e", `PROJECT_NAME=${name}`,
        "-e", `PROJECT_DESCRIPTION=${description}`,
        "-e", `OWNER_ID=${userId}`,
        "-e", `SANDBOX=true`,
        "conceptualai-sandbox:latest",
        "deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-read", "--allow-write", "--allow-sys", "src/main.ts"
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const { stdout, stderr, success } = await command.output();
    const containerId = new TextDecoder().decode(stdout).trim();
    const errorStr = new TextDecoder().decode(stderr).trim();

    if (!success) {
      console.error("[Sandboxing] Failed to start docker container:", errorStr);
      return { error: "Failed to start sandbox: " + errorStr };
    }

    console.log(`[Sandboxing] Successfully provisioned sandbox container: ${containerId.substring(0, 12)}`);

    await this.sandboxes.insertOne({
      _id: sandboxId,
      userId,
      containerId,
      endpoint: "ephemeral", // Not used in standalone mode
      status: "ready",
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    return { sandboxId };
  }

  /**
   * start (project: projectID)
   * effects: triggers the planning synchronization within the sandbox.
   */
  async start({ projectId, name, description, ownerId }: { projectId: ID; name: string; description: string; ownerId: ID }): Promise<Empty> {
    console.log(`[Sandboxing] Starting sandbox engine for project: ${name} (${projectId})`);
    return {};
  }

  /**
   * exit ()
   * effects: terminates the current process (called from within sandbox).
   */
  async exit(): Promise<Empty> {
    console.log("[Sandboxing] Project planning complete. Exiting sandbox...");
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
