import { Binary, Collection, Db, MongoClient } from "npm:mongodb";
import { freshID } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import {
  createPreviewProviderFromEnv,
  PreviewProvider,
} from "./providers/index.ts";

const PREFIX = "Previewing.";
const ASSEMBLIES_COLLECTION = "Assembling.assemblies";
const FRONTEND_JOBS_COLLECTION = "FrontendGenerating.jobs";

type Project = ID;
type User = ID;

type PreviewStatus =
  | "processing"
  | "ready"
  | "stopping"
  | "error"
  | "expired"
  | "stopped";

interface AssemblyDoc {
  _id: Project;
  zipData?: Binary;
  status?: "assembling" | "complete" | "error";
}

interface FrontendJobDoc {
  _id: Project;
  zipData?: Binary;
  status?: "processing" | "complete" | "error";
}

export interface PreviewDoc {
  _id: Project;
  owner: User;
  provider: string;
  status: PreviewStatus;
  backendAppId?: string;
  backendUrl?: string;
  frontendAppId?: string;
  frontendUrl?: string;
  previewDbName?: string;
  launchId?: string;
  expiresAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULT_TTL_MINUTES = 15;
const DEFAULT_DB_PREFIX = "preview";
const DEFAULT_MAX_ACTIVE = 1;
const DEFAULT_LAUNCH_TIMEOUT_MS = 20 * 60 * 1000;
const ACTIVE_STATUSES: PreviewStatus[] = ["processing", "ready", "stopping"];
const REAPABLE_STATUSES: PreviewStatus[] = ["processing", "ready"];
const MAX_PREVIEW_DB_NAME_LENGTH = 38;
const PREVIEW_DB_SEGMENT_PREFIX_MAX = 16;
const PREVIEW_DB_SEGMENT_PROJECT_MAX = 8;
const PREVIEW_DB_SEGMENT_LAUNCH_MAX = 12;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isEnabled(): boolean {
  const raw = (Deno.env.get("PREVIEWS_ENABLED") || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function binaryToBytes(binary?: Binary): Uint8Array | null {
  if (!binary) return null;
  return new Uint8Array(binary.buffer);
}

function sanitizeComponent(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "project";
}

function isLikelyPrivateMongoHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized === "localhost" || normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" || normalized === "::1" ||
    normalized === "host.docker.internal"
  ) {
    return true;
  }
  if (normalized.endsWith(".local")) return true;
  if (/^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  const private172 = normalized.match(/^172\.(\d+)\./);
  if (private172) {
    const secondOctet = Number.parseInt(private172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

/**
 * @concept Previewing
 * @purpose Launch and manage short-lived hosted previews for generated applications.
 */
export default class PreviewingConcept {
  public previews: Collection<PreviewDoc>;
  private assemblies: Collection<AssemblyDoc>;
  private frontendJobs: Collection<FrontendJobDoc>;
  private readonly providerName: string;
  private providerFactory: () => PreviewProvider;
  private provider: PreviewProvider | null = null;
  private launchTasks = new Map<Project, Promise<void>>();
  private teardownTasks = new Map<
    Project,
    Promise<{ stopped: number } | { error: string }>
  >();

  constructor(db: Db, providerFactory?: () => PreviewProvider) {
    this.previews = db.collection<PreviewDoc>(PREFIX + "previews");
    this.assemblies = db.collection<AssemblyDoc>(ASSEMBLIES_COLLECTION);
    this.frontendJobs = db.collection<FrontendJobDoc>(FRONTEND_JOBS_COLLECTION);
    this.providerName = (Deno.env.get("PREVIEW_PROVIDER") || "freestyle")
      .trim()
      .toLowerCase();
    this.providerFactory = providerFactory ?? createPreviewProviderFromEnv;
  }

  private log(message: string, data?: Record<string, unknown>) {
    if (data) {
      console.log(`[Previewing] ${message}`, data);
      return;
    }
    console.log(`[Previewing] ${message}`);
  }

  private summarizeDoc(
    doc: PreviewDoc | null | undefined,
  ): Record<string, unknown> {
    if (!doc) {
      return { exists: false };
    }
    return {
      exists: true,
      project: doc._id,
      owner: doc.owner,
      provider: doc.provider,
      status: doc.status,
      launchId: doc.launchId,
      backendAppId: doc.backendAppId,
      frontendAppId: doc.frontendAppId,
      previewDbName: doc.previewDbName,
      expiresAt: doc.expiresAt?.toISOString() ?? null,
    };
  }

  // Exposed for tests so sync-level tests can force a deterministic provider.
  setProviderFactoryForTest(factory: () => PreviewProvider) {
    this.providerFactory = factory;
    this.provider = null;
  }

  // Exposed for tests so sync-level tests can point to their ephemeral collections.
  setCollectionsForTest({
    previews,
    assemblies,
    frontendJobs,
  }: {
    previews?: Collection<PreviewDoc>;
    assemblies?: Collection<AssemblyDoc>;
    frontendJobs?: Collection<FrontendJobDoc>;
  }) {
    if (previews) {
      this.previews = previews;
    }
    if (assemblies) {
      this.assemblies = assemblies;
    }
    if (frontendJobs) {
      this.frontendJobs = frontendJobs;
    }
  }

  private getProvider(): PreviewProvider {
    if (!this.provider) {
      this.provider = this.providerFactory();
    }
    return this.provider;
  }

  private getTtlMinutes(): number {
    const ttlMinutes = Deno.env.get("PREVIEW_TTL_MINUTES");
    if (ttlMinutes) {
      return parsePositiveInt(ttlMinutes, DEFAULT_TTL_MINUTES);
    }

    const ttlHours = Deno.env.get("PREVIEW_TTL_HOURS");
    if (ttlHours) {
      return parsePositiveInt(ttlHours, DEFAULT_TTL_MINUTES / 60) * 60;
    }

    return DEFAULT_TTL_MINUTES;
  }

  private getMaxActivePerUser(): number {
    return parsePositiveInt(
      Deno.env.get("PREVIEW_MAX_ACTIVE_PER_USER"),
      DEFAULT_MAX_ACTIVE,
    );
  }

  private getLaunchTimeoutMs(): number {
    return parsePositiveInt(
      Deno.env.get("PREVIEW_LAUNCH_TIMEOUT_MS"),
      DEFAULT_LAUNCH_TIMEOUT_MS,
    );
  }

  private getPreviewMongoUrl(): string {
    const previewMongo = Deno.env.get("PREVIEW_MONGODB_URL")?.trim();
    if (previewMongo) return previewMongo;
    return Deno.env.get("MONGODB_URL")?.trim() || "";
  }

  private providerNeedsRemoteMongoReachability(): boolean {
    return this.providerName !== "mock";
  }

  private getPreviewMongoHostname(mongoUrl: string): string | null {
    try {
      return new URL(mongoUrl).hostname || null;
    } catch {
      return null;
    }
  }

  private buildPreviewMongoPreflightError(mongoUrl: string): string | null {
    if (!this.providerNeedsRemoteMongoReachability()) return null;
    const hostname = this.getPreviewMongoHostname(mongoUrl);
    if (!hostname || !isLikelyPrivateMongoHost(hostname)) return null;
    return `PREVIEW_MONGODB_URL must be reachable from the hosted preview VM. Current MongoDB host "${hostname}" is local/private and cannot be reached from ${this.providerName} previews.`;
  }

  private decorateLaunchError(
    message: string,
    previewMongoUrl: string,
  ): string {
    if (!message.includes("MongoDB connection failed:")) return message;

    const hostname = this.getPreviewMongoHostname(previewMongoUrl);
    const preflightError = this.buildPreviewMongoPreflightError(
      previewMongoUrl,
    );
    if (preflightError) {
      return `${preflightError} Use a publicly reachable MongoDB endpoint for previews.`;
    }

    if (
      message.includes("MongoNetworkTimeoutError") &&
      message.includes("secureConnect")
    ) {
      if (hostname) {
        return `Preview backend reached PREVIEW_MONGODB_URL host "${hostname}" from the hosted preview VM, but the TLS handshake timed out after TCP connect. ${message} DNS, SRV resolution, and raw socket reachability are not the failing step here; this points to a TLS/runtime trust or handshake issue on the preview VM path.`;
      }

      return `Preview backend reached PREVIEW_MONGODB_URL from the hosted preview VM, but the TLS handshake timed out after TCP connect. ${message}`;
    }

    if (hostname) {
      return `Preview backend could not reach PREVIEW_MONGODB_URL host "${hostname}" from the hosted preview VM. ${message} If you are using MongoDB Atlas, allow external access from the preview VM's egress or widen the network allowlist for testing.`;
    }

    return `Preview backend could not reach PREVIEW_MONGODB_URL from the hosted preview VM. ${message}`;
  }

  private buildPreviewDbName(project: Project, launchId: string): string {
    const rawPrefix = (Deno.env.get("PREVIEW_DB_PREFIX") || DEFAULT_DB_PREFIX)
      .trim();
    const prefix = sanitizeComponent(rawPrefix).slice(
      0,
      PREVIEW_DB_SEGMENT_PREFIX_MAX,
    ) || DEFAULT_DB_PREFIX;
    const projectPart = sanitizeComponent(project).slice(
      0,
      PREVIEW_DB_SEGMENT_PROJECT_MAX,
    ) || "project";
    const launchClean = sanitizeComponent(launchId);
    const launchPart = launchClean.slice(-PREVIEW_DB_SEGMENT_LAUNCH_MAX) ||
      "launch";

    const dbName = `${prefix}_${projectPart}_${launchPart}`;
    if (dbName.length <= MAX_PREVIEW_DB_NAME_LENGTH) return dbName;
    return dbName.slice(0, MAX_PREVIEW_DB_NAME_LENGTH);
  }

  private async dropPreviewDatabase(previewDbName?: string): Promise<void> {
    if (!previewDbName) return;
    const mongoUrl = this.getPreviewMongoUrl();
    if (!mongoUrl) return;
    const client = new MongoClient(mongoUrl);
    try {
      await client.connect();
      await client.db(previewDbName).dropDatabase();
    } catch (error) {
      console.warn(
        `[Previewing] Failed to drop preview database ${previewDbName}:`,
        error,
      );
    } finally {
      try {
        await client.close();
      } catch {
        // Ignore close failures.
      }
    }
  }

  private async teardownRemote(doc: PreviewDoc) {
    if (!doc.backendAppId && !doc.frontendAppId) return;
    await this.getProvider().teardown({
      backendAppId: doc.backendAppId,
      frontendAppId: doc.frontendAppId,
    });
  }

  private async markStatus(
    project: Project,
    status: PreviewStatus,
    patch: Partial<PreviewDoc> = {},
  ) {
    await this.previews.updateOne(
      { _id: project },
      {
        $set: {
          status,
          updatedAt: new Date(),
          ...patch,
        },
      },
    );
  }

  private async getArtifacts(project: Project): Promise<
    {
      backendZip: Uint8Array;
      frontendZip: Uint8Array;
    } | { error: string }
  > {
    const assembly = await this.assemblies.findOne({ _id: project });
    if (!assembly || assembly.status !== "complete") {
      return { error: "Backend assembly artifact is not ready." };
    }
    const backendZip = binaryToBytes(assembly.zipData);
    if (!backendZip) {
      return { error: "Backend assembly zip data is missing." };
    }

    const frontend = await this.frontendJobs.findOne({ _id: project });
    if (!frontend || frontend.status !== "complete") {
      return { error: "Frontend artifact is not ready." };
    }
    const frontendZip = binaryToBytes(frontend.zipData);
    if (!frontendZip) {
      return { error: "Frontend zip data is missing." };
    }

    return { backendZip, frontendZip };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]) as T;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        promise.catch(() => {
          // Ignore eventual provider completion after timeout escape.
        });
      }
    }
  }

  private async runLaunch(
    {
      project,
      owner,
      launchId,
      previewDbName,
    }: {
      project: Project;
      owner: User;
      launchId: string;
      previewDbName: string;
    },
  ): Promise<void> {
    const artifacts = await this.getArtifacts(project);
    if ("error" in artifacts) {
      await this.markStatus(project, "error", {
        lastError: artifacts.error,
      });
      return;
    }

    const previewMongoUrl = this.getPreviewMongoUrl();
    if (!previewMongoUrl) {
      await this.markStatus(project, "error", {
        lastError:
          "PREVIEW_MONGODB_URL (or fallback MONGODB_URL) is not configured.",
      });
      return;
    }

    const mongoPreflightError = this.buildPreviewMongoPreflightError(
      previewMongoUrl,
    );
    if (mongoPreflightError) {
      await this.markStatus(project, "error", {
        lastError: mongoPreflightError,
      });
      return;
    }

    const jwtSecret = crypto.randomUUID() + crypto.randomUUID();
    const launchTimeoutMs = this.getLaunchTimeoutMs();
    const launchPromise = this.getProvider().launch({
      project,
      launchId,
      backendZip: artifacts.backendZip,
      frontendZip: artifacts.frontendZip,
      backendEnv: {
        MONGODB_URL: previewMongoUrl,
        DB_NAME: previewDbName,
        JWT_SECRET: jwtSecret,
      },
    });
    const deployment = await this.withTimeout(
      launchPromise,
      launchTimeoutMs,
      "Preview launch",
    ).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const enrichedMessage = this.decorateLaunchError(
        message,
        previewMongoUrl,
      );
      await this.markStatus(project, "error", {
        lastError: enrichedMessage,
      });
      return null;
    });

    if (!deployment) return;

    const latest = await this.previews.findOne({ _id: project });
    if (!latest || latest.launchId !== launchId) {
      await this.getProvider().teardown({
        backendAppId: deployment.backendAppId,
        frontendAppId: deployment.frontendAppId,
      });
      return;
    }

    const expiresAt = new Date(Date.now() + this.getTtlMinutes() * 60 * 1000);
    await this.previews.updateOne(
      { _id: project },
      {
        $set: {
          owner,
          provider: this.providerName,
          status: "ready",
          backendAppId: deployment.backendAppId,
          backendUrl: deployment.backendUrl,
          frontendAppId: deployment.frontendAppId,
          frontendUrl: deployment.frontendUrl,
          previewDbName,
          expiresAt,
          lastError: undefined,
          updatedAt: new Date(),
        },
      },
    );
  }

  private async teardownWithStatus(
    project: Project,
    status: "stopped" | "expired",
    options?: {
      skipExistingTaskCheck?: boolean;
      alreadyMarkedStopping?: boolean;
    },
  ): Promise<{ stopped: number } | { error: string }> {
    const doc = await this.previews.findOne({ _id: project });
    if (!doc) {
      this.log("Teardown requested but no preview document exists", {
        project,
        targetStatus: status,
      });
      return { stopped: 0 };
    }

    const existingTask = this.teardownTasks.get(project);
    if (existingTask && !options?.skipExistingTaskCheck) {
      this.log(
        "Teardown requested while another teardown is already running; waiting for existing task",
        {
          project,
          targetStatus: status,
        },
      );
      return await existingTask;
    }

    if (!options?.alreadyMarkedStopping && doc.status !== "stopping") {
      await this.previews.updateOne(
        { _id: project },
        {
          $set: {
            status: "stopping",
            updatedAt: new Date(),
          },
        },
      );
      this.log("Preview marked as stopping", {
        project,
        targetStatus: status,
      });
    }

    return await this.runTeardownTask(project, doc, status);
  }

  private runTeardownTask(
    project: Project,
    doc: PreviewDoc,
    status: "stopped" | "expired",
  ): Promise<{ stopped: number } | { error: string }> {
    const task =
      (async (): Promise<{ stopped: number } | { error: string }> => {
        const startedAt = Date.now();
        this.log("Starting preview teardown", {
          project,
          targetStatus: status,
          preview: this.summarizeDoc(doc),
        });

        try {
          this.log("Waiting for remote preview teardown to finish", {
            project,
            targetStatus: status,
            backendAppId: doc.backendAppId ?? null,
            frontendAppId: doc.frontendAppId ?? null,
          });
          await this.teardownRemote(doc);
          this.log("Remote preview teardown finished", {
            project,
            targetStatus: status,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          this.log("Remote preview teardown failed", {
            project,
            targetStatus: status,
            elapsedMs: Date.now() - startedAt,
            error: message,
          });
          await this.previews.updateOne(
            { _id: project },
            {
              $set: {
                status: "error",
                lastError: `Failed to teardown preview deployment: ${message}`,
                updatedAt: new Date(),
              },
            },
          );
          return { error: `Failed to teardown preview: ${message}` };
        }

        this.log("Dropping preview database after remote teardown", {
          project,
          targetStatus: status,
          previewDbName: doc.previewDbName ?? null,
        });
        await this.dropPreviewDatabase(doc.previewDbName);
        await this.previews.updateOne(
          { _id: project },
          {
            $set: {
              status,
              launchId: undefined,
              backendAppId: undefined,
              backendUrl: undefined,
              frontendAppId: undefined,
              frontendUrl: undefined,
              expiresAt: status === "expired" ? new Date() : doc.expiresAt,
              updatedAt: new Date(),
            },
          },
        );
        this.launchTasks.delete(project);
        this.log("Preview teardown completed", {
          project,
          targetStatus: status,
          elapsedMs: Date.now() - startedAt,
        });
        return { stopped: 1 };
      })().finally(() => {
        this.teardownTasks.delete(project);
      });

    this.teardownTasks.set(project, task);
    return task;
  }

  private async beginScheduledTeardown(
    project: Project,
    status: "stopped" | "expired",
  ): Promise<
    { status: "preview_stopping" | "preview_stopped"; stopped: 0 } | {
      error: string;
    }
  > {
    const existingTask = this.teardownTasks.get(project);
    if (existingTask) {
      this.log(
        "Scheduled teardown requested while teardown is already running",
        {
          project,
          targetStatus: status,
        },
      );
      return { status: "preview_stopping", stopped: 0 };
    }

    const doc = await this.previews.findOne({ _id: project });
    if (!doc || doc.status === "stopped" || doc.status === "expired") {
      this.log(
        "Scheduled teardown requested for preview that is already inactive",
        {
          project,
          targetStatus: status,
          preview: this.summarizeDoc(doc),
        },
      );
      return { status: "preview_stopped", stopped: 0 };
    }

    if (doc.status !== "stopping") {
      await this.previews.updateOne(
        { _id: project },
        {
          $set: {
            status: "stopping",
            updatedAt: new Date(),
          },
        },
      );
      this.log("Preview marked as stopping from scheduled teardown request", {
        project,
        targetStatus: status,
        preview: this.summarizeDoc(doc),
      });
    } else {
      this.log(
        "Preview was already marked as stopping; scheduling teardown task",
        {
          project,
          targetStatus: status,
          preview: this.summarizeDoc(doc),
        },
      );
    }

    this.runTeardownTask(project, doc, status);
    return { status: "preview_stopping", stopped: 0 };
  }

  async launch({ project, owner }: { project: Project; owner: User }): Promise<
    { project: Project; status: "processing" } | { error: string }
  > {
    if (!isEnabled()) {
      return { error: "Previews are disabled." };
    }

    // Avoid duplicate launch churn if callers retry while the same launch is in-flight.
    if (this.launchTasks.has(project)) {
      return { project, status: "processing" };
    }

    await this.reapExpired();

    const activeCountRows = await this._getActiveByOwner({ owner });
    const activeCount = activeCountRows[0]?.active ?? 0;
    const currentPreviewRows = await this._getPreview({ project });
    const currentPreview = currentPreviewRows[0]?.preview;
    if (currentPreview?.status === "processing") {
      return { project, status: "processing" };
    }
    const maxActive = this.getMaxActivePerUser();
    const currentIsActive = !!currentPreview &&
      ACTIVE_STATUSES.includes(currentPreview.status);
    if (!currentIsActive && activeCount >= maxActive) {
      return {
        error: `Preview limit reached (${maxActive} active preview${
          maxActive === 1 ? "" : "s"
        } per user).`,
      };
    }

    const artifacts = await this.getArtifacts(project);
    if ("error" in artifacts) {
      return { error: artifacts.error };
    }

    const launchId = freshID();
    const previewDbName = this.buildPreviewDbName(project, launchId);

    if (currentPreview) {
      this.log(
        "Launch requested for project with existing preview; teardown will run before relaunch",
        {
          project,
          owner,
          nextLaunchId: launchId,
          existingPreview: this.summarizeDoc(currentPreview),
        },
      );
    }
    const teardownResult = await this.teardownWithStatus(project, "stopped");
    if ("error" in teardownResult) {
      this.log("Pre-launch preview teardown failed; aborting relaunch", {
        project,
        owner,
        nextLaunchId: launchId,
        error: teardownResult.error,
      });
      return teardownResult;
    }

    const now = new Date();
    await this.previews.updateOne(
      { _id: project },
      {
        $set: {
          owner,
          provider: this.providerName,
          status: "processing",
          launchId,
          previewDbName,
          backendAppId: undefined,
          backendUrl: undefined,
          frontendAppId: undefined,
          frontendUrl: undefined,
          expiresAt: undefined,
          lastError: undefined,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );

    const task = this.runLaunch({ project, owner, launchId, previewDbName })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.markStatus(project, "error", { lastError: message });
      })
      .finally(() => {
        this.launchTasks.delete(project);
      });
    this.launchTasks.set(project, task);

    return { project, status: "processing" };
  }

  async teardown(
    { project }: { project: Project },
  ): Promise<{ stopped: number } | { error: string }> {
    return await this.teardownWithStatus(project, "stopped");
  }

  async beginTeardown(
    { project }: { project: Project },
  ): Promise<
    {
      status: "preview_stopping" | "preview_stopped";
      stopped: 0;
    } | { error: string }
  > {
    return await this.beginScheduledTeardown(project, "stopped");
  }

  async deleteProject(
    { project }: { project: Project },
  ): Promise<{ deleted: number } | { error: string }> {
    const teardownResult = await this.teardownWithStatus(project, "stopped");
    if ("error" in teardownResult) {
      return teardownResult;
    }

    const result = await this.previews.deleteOne({ _id: project });
    return { deleted: result.deletedCount };
  }

  async reapExpired(
    _input: Record<string, never> = {},
  ): Promise<{ reaped: number }> {
    const now = new Date();
    const expired = await this.previews.find({
      status: { $in: REAPABLE_STATUSES },
      expiresAt: { $lt: now },
    }).toArray();

    let reaped = 0;
    for (const doc of expired) {
      const result = await this.beginScheduledTeardown(doc._id, "expired");
      if (!("error" in result) && result.status === "preview_stopping") {
        reaped += 1;
      }
    }
    return { reaped };
  }

  async _getPreview(
    { project }: { project: Project },
  ): Promise<Array<{ preview: PreviewDoc }>> {
    const doc = await this.previews.findOne({ _id: project });
    if (!doc) return [];
    return [{ preview: doc }];
  }

  _getTeardownInProgress(
    { project }: { project: Project },
  ): Promise<Array<{ inProgress: boolean }>> {
    return Promise.resolve([{ inProgress: this.teardownTasks.has(project) }]);
  }

  async _getActiveByOwner(
    { owner }: { owner: User },
  ): Promise<Array<{ active: number }>> {
    const now = new Date();
    const active = await this.previews.countDocuments({
      owner,
      status: { $in: ACTIVE_STATUSES },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
    });
    return [{ active }];
  }
}
