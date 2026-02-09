import { Binary, Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

const PREFIX = "FrontendGenerating.";

type Project = ID;

export interface FrontendJob {
  _id: Project;
  status: "processing" | "complete" | "error";
  downloadUrl?: string;
  zipData?: Binary;
  logs: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept FrontendGenerating
 * @purpose Generate a downloadable frontend repository based on a Design Plan and OpenAPI definition.
 */
export default class FrontendGeneratingConcept {
  public readonly jobs: Collection<FrontendJob>;

  constructor(private readonly db: Db) {
    this.jobs = this.db.collection<FrontendJob>(PREFIX + "jobs");
  }

  /**
   * generate (project: projectID, plan: Object, apiDefinition: Object, frontendGuide?: String) : (project: projectID, status: String)
   *
   * **requires**: no active job exists for project
   * **effects**: starts a generation job
   * Note: frontendGuide is accepted for backwards compatibility but no longer used internally.
   */
  generate = async ({
    project,
    plan,
    apiDefinition,
    frontendGuide: _frontendGuide,
  }: {
    project: Project;
    plan: Record<string, unknown>;
    apiDefinition: Record<string, unknown>;
    frontendGuide?: string;
  }): Promise<{
    project: Project;
    status: string;
  } | { error: string }> => {
    const existing = await this.jobs.findOne({ _id: project });
    if (existing && existing.status === "processing") {
      return { error: "Job already in progress for project" };
    }

    const doc: FrontendJob = {
      _id: project,
      status: "processing",
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (existing) {
        await this.jobs.updateOne({ _id: project }, { $set: doc });
    } else {
        await this.jobs.insertOne(doc);
    }

    // Trigger background generation
    this.runGeneration(project, plan, apiDefinition).catch(err => {
        console.error("Background generation failed:", err);
        this.jobs.updateOne({ _id: project }, {
            $set: { status: "error", updatedAt: new Date() },
            $push: { logs: `Error: ${err.message}` }
        });
    });

    return {
      project,
      status: "processing",
    };
  }

  /**
   * _getJob (project: projectID) : (job: FrontendJob)
   */
  _getJob = async ({ project }: { project: Project }): Promise<Array<FrontendJob>> => {
    const doc = await this.jobs.findOne({ _id: project });
    if (!doc) return [];
    return [doc];
  }

  async getFileStream({ project }: { project: Project }): Promise<ReadableStream<Uint8Array> | null> {
    const doc = await this.jobs.findOne({ _id: project });
    if (!doc || !doc.zipData) return null;

    // Convert Binary to Uint8Array and wrap in a simple ReadableStream
    const data = new Uint8Array(doc.zipData.buffer);

    return new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        }
    });
  }

  async _getDownloadUrl({ project }: { project: Project }): Promise<{ downloadUrl: string }> {
      const doc = await this.jobs.findOne({ _id: project });
      if (!doc || !doc.downloadUrl) return { downloadUrl: "" };
      return { downloadUrl: doc.downloadUrl };
  }

  private async runGeneration(project: Project, plan: Record<string, unknown>, apiDefinition: Record<string, unknown>) {
    console.log(`Starting generation for project ${project}...`);

    // Write plan, API spec to temp files to avoid command line length limits
    const tempDir = await Deno.makeTempDir({ prefix: `frontend_gen_${project}_` });
    const planPath = `${tempDir}/plan.json`;
    const apiSpecPath = `${tempDir}/api_spec.json`;
    const appGraphPath = `${tempDir}/app_graph.json`;
    
    // Write openapi.yaml into the generated frontend repo for reference
    let openapiYamlContent = "";
    if (apiDefinition && (apiDefinition as any).content) {
        openapiYamlContent = (apiDefinition as any).content;
    }
    
    try {
        // Write data to temp files
        await Deno.writeTextFile(planPath, JSON.stringify(plan));
        await Deno.writeTextFile(apiSpecPath, JSON.stringify(apiDefinition));
        // Write openapi.yaml to temp so generate_frontend can copy it into the output
        const openapiYamlPath = `${tempDir}/openapi.yaml`;
        if (openapiYamlContent) {
            await Deno.writeTextFile(openapiYamlPath, openapiYamlContent);
            console.log(`openapi.yaml written (${openapiYamlContent.length} chars)`);
        }
        
        // Check if apiDefinition has appGraph
        if (apiDefinition.appGraph) {
            await Deno.writeTextFile(appGraphPath, apiDefinition.appGraph as string);
            console.log(`App Graph written (${(apiDefinition.appGraph as string).length} chars)`);
        }
        
        const dyadPath = "src/concepts/FrontendGenerating/dyad";
        const scriptPath = "scripts/generate_frontend.ts";

        // Run the script - use cmd.exe on Windows to handle .cmd files like npx
        // Pass file paths instead of raw JSON to avoid command line length limits
        const isWindows = Deno.build.os === "windows";
        const npxArgs = ["-y", "ts-node", scriptPath, project, `--plan-file=${planPath}`, `--api-file=${apiSpecPath}`];

        // Add openapi.yaml file path so it gets copied into the frontend repo
        if (openapiYamlContent) {
            npxArgs.push(`--openapi-yaml-file=${openapiYamlPath}`);
        }

        // Add App Graph file path if it exists
        if (apiDefinition.appGraph) {
            npxArgs.push(`--app-graph-file=${appGraphPath}`);
        }
        
        const command = isWindows 
            ? new Deno.Command("cmd", {
                args: ["/c", "npx", ...npxArgs],
                cwd: dyadPath,
                stdout: "piped",
                stderr: "piped",
                env: {
                    PATH: Deno.env.get("PATH") || "",
                    OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") || "",
                    GEMINI_API_KEY: Deno.env.get("GEMINI_API_KEY") || "",
                    GOOGLE_GENERATIVE_AI_API_KEY: Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY") || "",
                }
            })
            : new Deno.Command("npx", {
                args: npxArgs,
                cwd: dyadPath,
                stdout: "piped",
                stderr: "piped",
                env: {
                    PATH: Deno.env.get("PATH") || "",
                    OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") || "",
                    GEMINI_API_KEY: Deno.env.get("GEMINI_API_KEY") || "",
                    GOOGLE_GENERATIVE_AI_API_KEY: Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY") || "",
                }
            });

        const process = command.spawn();
        const decoder = new TextDecoder();
        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: Uint8Array[] = [];

        const collectStream = async (
          stream: ReadableStream<Uint8Array> | null,
          label: "stdout" | "stderr",
          chunks: Uint8Array[]
        ) => {
          if (!stream) return;
          const reader = stream.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                chunks.push(value);
                const text = decoder.decode(value);
                if (text) {
                  console.log(`[FrontendGenerating:${project}] ${label}: ${text}`);
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        };

        const [status] = await Promise.all([
          process.status,
          collectStream(process.stdout, "stdout", stdoutChunks),
          collectStream(process.stderr, "stderr", stderrChunks),
        ]);

        const concat = (chunks: Uint8Array[]) => {
          const total = chunks.reduce((sum, c) => sum + c.length, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          return merged;
        };

        const outputStr = decoder.decode(concat(stdoutChunks));
        const errorStr = decoder.decode(concat(stderrChunks));

        if (!status.success) {
            throw new Error(`Generation script failed: ${errorStr}\nOutput: ${outputStr}`);
        }

        console.log("Generation output:", outputStr);

        // Parse artifact path from output if possible, or assume standard path
        // Script outputs JSON on success: {"success":true,"artifactPath":"..."}
        // Let's try to find the JSON line
        const lines = outputStr.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        let artifactPath = "";
        try {
            const res = JSON.parse(lastLine);
            if (res.success && res.artifactPath) {
                artifactPath = res.artifactPath;
            }
        } catch (e) {
            // ignore
        }

        if (!artifactPath) {
             artifactPath = `src/concepts/FrontendGenerating/dyad/out/${project}-frontend.zip`;
        }

        // Read the artifact into a buffer
        let zipData: Binary | undefined;
        try {
            const rawData = await Deno.readFile(artifactPath);
            zipData = new Binary(rawData);
        } catch (readErr) {
            console.warn(`Could not read artifact at ${artifactPath}:`, readErr);
        }

        const downloadUrl = `/api/downloads/${project}_frontend.zip`;

        await this.jobs.updateOne({ _id: project }, {
            $set: {
                status: "complete",
                downloadUrl,
                zipData,
                updatedAt: new Date()
            },
            $push: { logs: `Generation completed.\nSTDOUT:\n${outputStr}\nSTDERR:\n${errorStr}` }
        });

        // Cleanup local file after storage (optional, but good for stateless)
        // For now, we keep it as backup or for manual inspection, or we could delete it:
        // await Deno.remove(artifactPath);

    } catch (error: any) {
        console.error("Generation failed:", error);
        await this.jobs.updateOne({ _id: project }, {
            $set: { status: "error", updatedAt: new Date() },
            $push: { logs: `Error: ${error.message}` }
        });
    } finally {
        // Cleanup temp files
        try {
            await Deno.remove(tempDir, { recursive: true });
        } catch {
            // ignore cleanup errors
        }
    }
  }
}
