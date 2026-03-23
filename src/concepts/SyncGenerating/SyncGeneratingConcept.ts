import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import type { Implementation } from "../Implementing/ImplementingConcept.ts";

const PREFIX = "SyncGenerating.";

type Project = ID;

export interface SyncDefinition {
  name: string;
  when: {
    [actionPattern: string]: Record<string, string>;
  };
  where?: string;
  then: Array<[string, Record<string, string>]>;
}

export interface ApiEndpointDefinition {
  method: string;
  path: string;
  concept: string;
  action: string;
  description?: string;
  request?: Record<string, string>;
  response?: Record<string, string>;
}

export interface ApiDefinition {
  format: "openapi";
  encoding: "yaml";
  content: string;
  endpoints?: ApiEndpointDefinition[];
}

export interface EndpointBundle {
  endpoint: {
    method: string;
    path: string;
    summary?: string;
    description?: string;
  };
  aiTouching?: boolean;
  validationTimeoutMs?: number;
  syncs: SyncDefinition[];
  testFile: string;
  syncFile: string;
  compile?: { ok: boolean; errors?: string };
  test?: { ok: boolean; errors?: string };
}

/**
 * State:
 * a set of SyncJobs with
 *   a project ID
 *   a syncs Array<SyncDefinition>
 *   an apiDefinition Object
 *   an endpointBundles Array<EndpointBundle>
 *   a flowAnalysis String (detailed reasoning about user flows)
 *   a frontendGuide String (comprehensive guide for frontend API usage)
 *   a status String
 */
export interface SyncJobDoc {
  _id: Project;
  syncs: SyncDefinition[];
  apiDefinition: ApiDefinition;
  endpointBundles: EndpointBundle[];
  flowAnalysis?: string;
  frontendGuide?: string;
  status: "processing" | "complete" | "error";
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept SyncGenerating
 * @purpose Generate synchronizations that wire concepts together and define the API surface.
 */
export default class SyncGeneratingConcept {
  public readonly syncJobs: Collection<SyncJobDoc>;

  constructor(private readonly db: Db) {
    this.syncJobs = this.db.collection<SyncJobDoc>(PREFIX + "syncJobs");
  }

  /**
   * Helper to call the Python DSPy script
   */
  private async callAgent(
    action: "generate",
    payload: {
      plan: Record<string, unknown>;
      conceptSpecs: string;
      implementations: Record<string, Implementation>;
    },
  ): Promise<
    {
      syncs: SyncDefinition[];
      apiDefinition: ApiDefinition;
      endpointBundles: EndpointBundle[];
      flowAnalysis?: string;
      frontendGuide?: string;
    } | { error: string }
  > {
    try {
      const pythonCmd = Deno.build.os === "windows" ? "python" : "python3";
      const scriptPath = "src/concepts/SyncGenerating/dspy/main.py";

      const command = new Deno.Command(pythonCmd, {
        args: [scriptPath],
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
        env: {
          ...Deno.env.toObject(),
          "PYTHONDONTWRITEBYTECODE": "1",
        },
      });

      const process = command.spawn();
      const writer = process.stdin.getWriter();

      await writer.write(
        new TextEncoder().encode(JSON.stringify({ action, payload })),
      );
      await writer.close();

      const { stdout, success } = await process.output();
      const outputStr = new TextDecoder().decode(stdout);
      const errorStr = "";

      if (!success) {
        console.error("DSPy script failed:", errorStr);
        return { error: "Internal sync generation script error" };
      }

      try {
        const result = JSON.parse(outputStr);
        if (result.error) {
          console.error("DSPy script returned error:", result.error);
          return { error: result.error };
        }
        return result;
      } catch (e) {
        console.error("Failed to parse DSPy output:", outputStr);
        console.error("Stderr:", errorStr);
        return { error: "Invalid response from sync generator" };
      }
    } catch (error) {
      console.error("Failed to call DSPy sync generator:", error);
      return { error: "Failed to call DSPy sync generator" };
    }
  }

  /**
   * generate (project: projectID, plan: Object, conceptSpecs: String, implementations: Object) : (project: projectID, syncs: Array, apiDefinition: Object, endpointBundles: Array)
   *
   * **requires**: no sync job exists for project
   * **effects**: calls DSPy agent to generate sync definitions and API definition, stores result
   */
  generate = async ({
    project,
    plan,
    conceptSpecs,
    implementations,
  }: {
    project: Project;
    plan: Record<string, unknown>;
    conceptSpecs: string;
    implementations: Record<string, Implementation>;
  }): Promise<
    {
      project: Project;
      syncs: SyncDefinition[];
      apiDefinition: ApiDefinition;
      endpointBundles: EndpointBundle[];
    } | {
      error: string;
    }
  > => {
    const existing = await this.syncJobs.findOne({ _id: project });
    if (existing) {
      return { error: "Sync job already exists for project" };
    }

    const result = await this.callAgent("generate", {
      plan,
      conceptSpecs,
      implementations,
    });
    if ("error" in result) {
      return { error: result.error };
    }

    // Validate all endpoints have sync files
    const missingSyncs: string[] = [];
    for (const bundle of result.endpointBundles) {
      const endpoint = bundle.endpoint;
      if (!bundle.syncFile || !bundle.syncFile.trim()) {
        missingSyncs.push(`${endpoint.method} ${endpoint.path}`);
      }
    }

    if (missingSyncs.length > 0) {
      console.warn("[SyncGenerating] WARNING: The following endpoints are missing sync files:");
      for (const ep of missingSyncs) {
        console.warn(`  - ${ep}`);
      }
      console.warn("[SyncGenerating] These endpoints will NOT work in the generated application!");
    }

    // Report stats
    const totalEndpoints = result.endpointBundles.length;
    const successfulSyncs = totalEndpoints - missingSyncs.length;
    console.log(`[SyncGenerating] Generated syncs for ${successfulSyncs}/${totalEndpoints} endpoints.`);
    
    if (result.flowAnalysis) {
      console.log(`[SyncGenerating] Flow analysis generated (${result.flowAnalysis.length} chars).`);
    }
    if (result.frontendGuide) {
      console.log(`[SyncGenerating] Frontend guide generated (${result.frontendGuide.length} chars).`);
    }

    const now = new Date();
    const doc: SyncJobDoc = {
      _id: project,
      syncs: result.syncs,
      apiDefinition: result.apiDefinition,
      endpointBundles: result.endpointBundles,
      flowAnalysis: result.flowAnalysis,
      frontendGuide: result.frontendGuide,
      status: "complete",
      createdAt: now,
      updatedAt: now,
    };

    await this.syncJobs.insertOne(doc);

    return {
      project,
      syncs: doc.syncs,
      apiDefinition: doc.apiDefinition,
      endpointBundles: doc.endpointBundles,
    };
  }

  /**
   * _getSyncs(project: projectID) : (syncs: Object, apiDefinition: Object, endpointBundles: Array, frontendGuide: String)
   * Note: frontendGuide is kept for backwards compatibility with build.sync.ts but is no longer consumed downstream.
   */
  _getSyncs = async (
    { project }: { project: Project },
  ): Promise<
    Array<{
      syncs: SyncDefinition[];
      apiDefinition: ApiDefinition;
      endpointBundles: EndpointBundle[];
      frontendGuide?: string;
    }>
  > => {
    const doc = await this.syncJobs.findOne({ _id: project });
    if (!doc) return [];
    return [{
      syncs: doc.syncs,
      apiDefinition: doc.apiDefinition,
      endpointBundles: doc.endpointBundles,
      frontendGuide: doc.frontendGuide,
    }];
  }

  /**
   * deleteProject (project: projectID) : (deleted: Number)
   * effects: deletes generated sync artifacts for a project
   */
  deleteProject = async (
    { project }: { project: Project },
  ): Promise<{ deleted: number }> => {
    const result = await this.syncJobs.deleteOne({ _id: project });
    return { deleted: result.deletedCount };
  }
}
