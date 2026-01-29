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
 *   a status String
 */
export interface SyncJobDoc {
  _id: Project;
  syncs: SyncDefinition[];
  apiDefinition: ApiDefinition;
  endpointBundles: EndpointBundle[];
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
            "PYTHONDONTWRITEBYTECODE": "1"
        }
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

    const now = new Date();
    const doc: SyncJobDoc = {
      _id: project,
      syncs: result.syncs,
      apiDefinition: result.apiDefinition,
      endpointBundles: result.endpointBundles,
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
   * _getSyncs(project: projectID) : (syncs: Object, apiDefinition: Object, endpointBundles: Array)
   */
  _getSyncs = async (
    { project }: { project: Project },
  ): Promise<
    Array<{
      syncs: SyncDefinition[];
      apiDefinition: ApiDefinition;
      endpointBundles: EndpointBundle[];
    }>
  > => {
    const doc = await this.syncJobs.findOne({ _id: project });
    if (!doc) return [];
    return [{
      syncs: doc.syncs,
      apiDefinition: doc.apiDefinition,
      endpointBundles: doc.endpointBundles,
    }];
  }
}
