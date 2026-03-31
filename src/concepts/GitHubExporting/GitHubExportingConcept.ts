import { Binary, Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";

const PREFIX = "GitHubExporting.";
const ASSEMBLING_COLLECTION = "Assembling.assemblies";
const FRONTEND_COLLECTION = "FrontendGenerating.jobs";
const GITHUB_API_BASE = "https://api.github.com";

type Project = ID;
type User = ID;
type Artifact = "backend" | "frontend";
type Visibility = "public" | "private";
type ExportStatus = "processing" | "complete" | "error" | "stale";

interface ArtifactDoc {
  _id: Project;
  status?: string;
  zipData?: Binary;
}

interface ExportJobDoc {
  _id: string;
  project: Project;
  artifact: Artifact;
  user: User;
  repoName: string;
  visibility: Visibility;
  status: ExportStatus;
  repoUrl?: string;
  repoOwner?: string;
  repoId?: string;
  remoteExists?: boolean;
  lastRemoteCheckAt?: Date;
  logs: string[];
  createdAt: Date;
  updatedAt: Date;
}

type ExportCrudResult = { ok: true } | { error: string };
type ExportDeleteResult = { deleted: number };
type StartExportResult =
  | {
    status: "processing";
    repoName: string;
    visibility: Visibility;
  }
  | {
    error: string;
    statusCode?: number;
  };

function normalizeArtifact(value: unknown): Artifact | null {
  if (value === "backend" || value === "frontend") return value;
  return null;
}

function normalizeVisibility(value: unknown): Visibility {
  return value === "public" ? "public" : "private";
}

function normalizeRepoName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function sanitizeLogMessage(message: string, secrets: string[]): string {
  let sanitized = message;
  for (const secret of secrets) {
    if (!secret) continue;
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized
    .replace(
      /(access_token|refresh_token|client_secret|code)=([^&\s]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._\-=/+]+/gi, "Bearer [REDACTED]")
    .replace(
      /https:\/\/[^:\s]+:[^@]+@github\.com/gi,
      "https://[REDACTED]@github.com",
    )
    .slice(0, 4000);
}

function extractGitHubErrorMessage(payloadText: string): string {
  const trimmed = payloadText.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const first = parsed.errors[0];
      if (typeof first === "string" && first.trim().length > 0) {
        return first.trim();
      }
      if (first && typeof first === "object" && "message" in first) {
        const message = (first as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim().length > 0) {
          return message.trim();
        }
      }
    }
  } catch {
    // Fall back to the raw payload text.
  }
  return trimmed.slice(0, 500);
}

export const githubExportingTestables = {
  normalizeRepoName,
  sanitizeLogMessage,
};

export default class GitHubExportingConcept {
  jobs: Collection<ExportJobDoc>;
  private readonly backendArtifacts: Collection<ArtifactDoc>;
  private readonly frontendArtifacts: Collection<ArtifactDoc>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.jobs = this.db.collection<ExportJobDoc>(PREFIX + "jobs");
    this.backendArtifacts = this.db.collection<ArtifactDoc>(ASSEMBLING_COLLECTION);
    this.frontendArtifacts = this.db.collection<ArtifactDoc>(FRONTEND_COLLECTION);
  }

  private jobId(project: Project, artifact: Artifact): string {
    return `${project}:${artifact}`;
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.jobs.createIndex({ project: 1, artifact: 1 }, { unique: true });
    await this.jobs.createIndex({ project: 1, updatedAt: -1 });
    await this.jobs.createIndex({ user: 1, updatedAt: -1 });
    this.indexesCreated = true;
  }

  private async appendLog(
    project: Project,
    artifact: Artifact,
    message: string,
    secrets: string[] = [],
  ): Promise<void> {
    await this.jobs.updateOne(
      { _id: this.jobId(project, artifact) },
      {
        $set: { updatedAt: new Date() },
        $push: {
          logs: sanitizeLogMessage(message, secrets),
        },
      },
    );
  }

  private async loadArtifactZip(
    project: Project,
    artifact: Artifact,
  ): Promise<Uint8Array | null> {
    const collection = artifact === "backend"
      ? this.backendArtifacts
      : this.frontendArtifacts;
    const doc = await collection.findOne({ _id: project });
    if (!doc || !doc.zipData) return null;
    return new Uint8Array(doc.zipData.buffer);
  }

  private async githubRequest(
    input: string,
    init: RequestInit,
    accessToken: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return await fetch(input, {
      ...init,
      headers,
    });
  }

  private async createRemoteRepo(
    repoName: string,
    visibility: Visibility,
    accessToken: string,
  ): Promise<
    | {
      repoName: string;
      repoOwner: string;
      repoId: string;
      repoUrl: string;
    }
    | {
      error: string;
    }
  > {
    const response = await this.githubRequest(
      `${GITHUB_API_BASE}/user/repos`,
      {
        method: "POST",
        body: JSON.stringify({
          name: repoName,
          private: visibility !== "public",
          auto_init: false,
        }),
      },
      accessToken,
    );
    const payloadText = await response.text();
    if (!response.ok) {
      return {
        error: extractGitHubErrorMessage(payloadText) ||
          "Failed to create GitHub repository.",
      };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadText) as Record<string, unknown>;
    } catch {
      return { error: "GitHub returned an invalid repository creation response." };
    }

    const owner = payload.owner && typeof payload.owner === "object"
      ? (payload.owner as Record<string, unknown>)
      : {};
    const createdRepoName = typeof payload.name === "string"
      ? payload.name
      : repoName;
    const repoOwner = typeof owner.login === "string" ? owner.login : "";
    const repoId = String(payload.id ?? "");
    const repoUrl = typeof payload.html_url === "string" ? payload.html_url : "";
    if (!repoOwner || !repoId || !repoUrl) {
      return { error: "GitHub returned incomplete repository metadata." };
    }
    return {
      repoName: createdRepoName,
      repoOwner,
      repoId,
      repoUrl,
    };
  }

  private async extractZipToDirectory(
    zipData: Uint8Array,
    targetDirectory: string,
  ): Promise<void> {
    const zip = await JSZip.loadAsync(zipData);
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      const outputPath = path.join(targetDirectory, entryPath);
      if (entry.dir) {
        await Deno.mkdir(outputPath, { recursive: true });
        continue;
      }
      await Deno.mkdir(path.dirname(outputPath), { recursive: true });
      const fileData = await entry.async("uint8array");
      await Deno.writeFile(outputPath, fileData);
    }
  }

  private async runGitCommand(
    args: string[],
    cwd: string,
    secrets: string[],
  ): Promise<{ ok: true } | { error: string }> {
    try {
      const command = new Deno.Command("git", {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stdout, stderr } = await command.output();
      if (code === 0) {
        return { ok: true };
      }
      const output = new TextDecoder().decode(stdout) +
        new TextDecoder().decode(stderr);
      return {
        error: sanitizeLogMessage(output || `git ${args.join(" ")} failed`, secrets),
      };
    } catch (error) {
      return {
        error: sanitizeLogMessage(
          error instanceof Error ? error.message : String(error),
          secrets,
        ),
      };
    }
  }

  private async initializeGitRepository(
    workingDirectory: string,
    repoOwner: string,
    repoName: string,
    accessToken: string,
  ): Promise<{ ok: true } | { error: string }> {
    const remoteUrl =
      `https://x-access-token:${accessToken}@github.com/${repoOwner}/${repoName}.git`;
    const secrets = [accessToken];
    const commands = [
      ["init"],
      ["branch", "-M", "main"],
      ["add", "-A"],
      [
        "-c",
        "user.name=ConceptualAI",
        "-c",
        "user.email=noreply@conceptualai.local",
        "commit",
        "-m",
        "Initial export from ConceptualAI",
      ],
      ["remote", "add", "origin", remoteUrl],
      ["push", "--set-upstream", "origin", "main"],
    ];
    for (const commandArgs of commands) {
      const result = await this.runGitCommand(commandArgs, workingDirectory, secrets);
      if ("error" in result) {
        return result;
      }
    }
    return { ok: true };
  }

  private async runExport({
    project,
    artifact,
    repoName,
    visibility,
    accessToken,
    zipData,
  }: {
    project: Project;
    artifact: Artifact;
    repoName: string;
    visibility: Visibility;
    accessToken: string;
    zipData: Uint8Array;
  }): Promise<void> {
    const secrets = [accessToken];
    let tempDir = "";
    try {
      await this.appendLog(project, artifact, "Creating GitHub repository.", secrets);
      const repoResult = await this.createRemoteRepo(
        repoName,
        visibility,
        accessToken,
      );
      if ("error" in repoResult) {
        await this.jobs.updateOne(
          { _id: this.jobId(project, artifact) },
          {
            $set: {
              status: "error",
              updatedAt: new Date(),
            },
          },
        );
        await this.appendLog(project, artifact, repoResult.error, secrets);
        return;
      }

      await this.jobs.updateOne(
        { _id: this.jobId(project, artifact) },
        {
          $set: {
            repoName: repoResult.repoName,
            repoOwner: repoResult.repoOwner,
            repoId: repoResult.repoId,
            repoUrl: repoResult.repoUrl,
            remoteExists: true,
            lastRemoteCheckAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      await this.appendLog(
        project,
        artifact,
        `Created GitHub repository ${repoResult.repoOwner}/${repoResult.repoName}.`,
        secrets,
      );

      tempDir = await Deno.makeTempDir({
        prefix: `github_export_${project}_${artifact}_`,
      });
      await this.extractZipToDirectory(zipData, tempDir);
      await this.appendLog(project, artifact, "Prepared artifact contents for git push.");

      const pushResult = await this.initializeGitRepository(
        tempDir,
        repoResult.repoOwner,
        repoResult.repoName,
        accessToken,
      );
      if ("error" in pushResult) {
        await this.jobs.updateOne(
          { _id: this.jobId(project, artifact) },
          {
            $set: {
              status: "error",
              remoteExists: true,
              lastRemoteCheckAt: new Date(),
              updatedAt: new Date(),
            },
          },
        );
        await this.appendLog(project, artifact, pushResult.error, secrets);
        return;
      }

      await this.jobs.updateOne(
        { _id: this.jobId(project, artifact) },
        {
          $set: {
            status: "complete",
            remoteExists: true,
            lastRemoteCheckAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
      await this.appendLog(
        project,
        artifact,
        `Export complete: ${repoResult.repoUrl}`,
      );
    } catch (error) {
      await this.jobs.updateOne(
        { _id: this.jobId(project, artifact) },
        {
          $set: {
            status: "error",
            updatedAt: new Date(),
          },
        },
      );
      await this.appendLog(
        project,
        artifact,
        error instanceof Error ? error.message : String(error),
        secrets,
      );
    } finally {
      if (tempDir) {
        try {
          await Deno.remove(tempDir, { recursive: true });
        } catch {
          // Ignore temp dir cleanup failures.
        }
      }
    }
  }

  async createExport(
    {
      user,
      project,
      artifact,
      repoName,
      visibility,
      status,
    }: {
      user: User;
      project: Project;
      artifact: Artifact;
      repoName: string;
      visibility: string;
      status: string;
    },
  ): Promise<ExportCrudResult> {
    await this.ensureIndexes();
    const normalizedArtifact = normalizeArtifact(artifact);
    if (!normalizedArtifact) return { error: "Invalid export artifact." };
    const normalizedRepoName = normalizeRepoName(repoName);
    if (!normalizedRepoName) return { error: "Invalid GitHub repository name." };
    const normalizedVisibility = normalizeVisibility(visibility);
    const normalizedStatus = status === "complete" || status === "error" ||
        status === "stale"
      ? status
      : "processing";

    const now = new Date();
    try {
      await this.jobs.insertOne({
        _id: this.jobId(project, normalizedArtifact),
        project,
        artifact: normalizedArtifact,
        user,
        repoName: normalizedRepoName,
        visibility: normalizedVisibility,
        status: normalizedStatus,
        logs: [],
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      return { error: "Export record already exists for this artifact." };
    }
    return { ok: true };
  }

  async updateExport(
    {
      project,
      artifact,
      patch,
    }: {
      project: Project;
      artifact: Artifact;
      patch: Record<string, unknown>;
    },
  ): Promise<ExportCrudResult> {
    const normalizedArtifact = normalizeArtifact(artifact);
    if (!normalizedArtifact) return { error: "Invalid export artifact." };
    const result = await this.jobs.updateOne(
      { _id: this.jobId(project, normalizedArtifact) },
      {
        $set: {
          ...patch,
          updatedAt: new Date(),
        },
      },
    );
    if (result.matchedCount === 0) {
      return { error: "Export record not found." };
    }
    return { ok: true };
  }

  async checkRemoteExport(
    {
      project,
      artifact,
      accessToken,
    }: {
      project: Project;
      artifact: Artifact;
      accessToken: string;
    },
  ): Promise<{ remoteExists: boolean } | { error: string }> {
    const normalizedArtifact = normalizeArtifact(artifact);
    if (!normalizedArtifact) return { error: "Invalid export artifact." };
    const job = await this.jobs.findOne({ _id: this.jobId(project, normalizedArtifact) });
    if (!job || !job.repoOwner || !job.repoName) {
      return { remoteExists: false };
    }

    const response = await this.githubRequest(
      `${GITHUB_API_BASE}/repos/${job.repoOwner}/${job.repoName}`,
      { method: "GET" },
      accessToken,
    );
    const remoteExists = response.status !== 404 && response.ok;
    await this.jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          remoteExists,
          lastRemoteCheckAt: new Date(),
          status: remoteExists ? job.status : "stale",
          updatedAt: new Date(),
        },
      },
    );
    if (!remoteExists && response.status !== 404 && !response.ok) {
      const payloadText = await response.text();
      return {
        error: extractGitHubErrorMessage(payloadText) ||
          "Unable to verify remote GitHub repository status.",
      };
    }
    return { remoteExists };
  }

  async startExport(
    {
      user,
      project,
      artifact,
      repoName,
      visibility,
      accessToken,
    }: {
      user: User;
      project: Project;
      artifact: Artifact;
      repoName: string;
      visibility: string;
      accessToken: string;
    },
  ): Promise<StartExportResult> {
    await this.ensureIndexes();
    const normalizedArtifact = normalizeArtifact(artifact);
    if (!normalizedArtifact) {
      return { error: "Invalid export artifact.", statusCode: 400 };
    }
    const normalizedRepoName = normalizeRepoName(repoName);
    if (!normalizedRepoName) {
      return { error: "Invalid GitHub repository name.", statusCode: 400 };
    }
    const normalizedVisibility = normalizeVisibility(visibility);
    const zipData = await this.loadArtifactZip(project, normalizedArtifact);
    if (!zipData) {
      return {
        error: "Requested build artifact is not available for export.",
        statusCode: 404,
      };
    }

    const existing = await this.jobs.findOne({
      _id: this.jobId(project, normalizedArtifact),
    });
    if (existing && existing.status === "processing") {
      return { error: "GitHub export is already in progress.", statusCode: 409 };
    }
    if (existing && existing.repoOwner && existing.repoName) {
      const remoteCheck = await this.checkRemoteExport({
        project,
        artifact: normalizedArtifact,
        accessToken,
      });
      if ("error" in remoteCheck) {
        return { error: remoteCheck.error, statusCode: 502 };
      }
      if (remoteCheck.remoteExists) {
        return {
          error: "This artifact is already exported to a live GitHub repository.",
          statusCode: 409,
        };
      }
    }

    const now = new Date();
    const nextJob: ExportJobDoc = {
      _id: this.jobId(project, normalizedArtifact),
      project,
      artifact: normalizedArtifact,
      user,
      repoName: normalizedRepoName,
      visibility: normalizedVisibility,
      status: "processing",
      repoUrl: existing?.repoUrl,
      repoOwner: existing?.repoOwner,
      repoId: existing?.repoId,
      remoteExists: existing?.remoteExists,
      lastRemoteCheckAt: existing?.lastRemoteCheckAt,
      logs: existing
        ? [...existing.logs, "Queued a new GitHub export attempt."]
        : ["Queued a new GitHub export attempt."],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const { createdAt, ...updatableJob } = nextJob;
    await this.jobs.updateOne(
      { _id: nextJob._id },
      { $set: updatableJob, $setOnInsert: { createdAt } },
      { upsert: true },
    );

    void this.runExport({
      project,
      artifact: normalizedArtifact,
      repoName: normalizedRepoName,
      visibility: normalizedVisibility,
      accessToken,
      zipData,
    });

    return {
      status: "processing",
      repoName: normalizedRepoName,
      visibility: normalizedVisibility,
    };
  }

  async deleteExport(
    { project, artifact }: { project: Project; artifact: Artifact },
  ): Promise<ExportDeleteResult> {
    const normalizedArtifact = normalizeArtifact(artifact);
    if (!normalizedArtifact) return { deleted: 0 };
    const result = await this.jobs.deleteOne({
      _id: this.jobId(project, normalizedArtifact),
    });
    return { deleted: result.deletedCount };
  }

  async deleteProject(
    { project }: { project: Project },
  ): Promise<ExportDeleteResult> {
    const result = await this.jobs.deleteMany({ project });
    return { deleted: result.deletedCount };
  }

  async _getExport(
    { project, artifact }: { project: Project; artifact: Artifact },
  ): Promise<Array<{ job: ExportJobDoc }>> {
    const normalizedArtifact = normalizeArtifact(artifact);
    if (!normalizedArtifact) return [];
    const job = await this.jobs.findOne({ _id: this.jobId(project, normalizedArtifact) });
    if (!job) return [];
    return [{ job }];
  }

  async _listExportsByProject(
    { project }: { project: Project },
  ): Promise<Array<{ job: ExportJobDoc }>> {
    const jobs = await this.jobs.find({ project }).sort({ updatedAt: -1 }).toArray();
    return jobs.map((job) => ({ job }));
  }

  async _listExportsByUser(
    { user }: { user: User },
  ): Promise<Array<{ job: ExportJobDoc }>> {
    const jobs = await this.jobs.find({ user }).sort({ updatedAt: -1 }).toArray();
    return jobs.map((job) => ({ job }));
  }
}
