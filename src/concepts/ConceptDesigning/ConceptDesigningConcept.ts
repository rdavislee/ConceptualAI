import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

const PREFIX = "ConceptDesigning.";

// Generic types
type Project = ID;

export interface LibraryPull {
  libraryName: string;
  instanceName: string;
  bindings: Record<string, string>;
}

export interface CustomConcept {
  name: string;
  spec: string;
}

/**
 * State:
 * a set of Designs with
 *   a project ID
 *   a plan Object
 *   a libraryPulls Array<{ libraryName: String, instanceName: String, bindings: Object }>
 *   a customConcepts Array<{ name: String, spec: String }>
 *   a status String
 */
export interface DesignDoc {
  _id: Project;
  plan: Record<string, any>;
  libraryPulls: LibraryPull[];
  customConcepts: CustomConcept[];
  status: string;
  createdAt: Date;
}

/**
 * @concept ConceptDesigning
 * @purpose Select library concepts and write specs for custom concepts, given a plan.
 */
export default class ConceptDesigningConcept {
  public readonly designs: Collection<DesignDoc>;

  constructor(private readonly db: Db) {
    this.designs = this.db.collection<DesignDoc>(PREFIX + "designs");
  }

  /**
   * Helper to call the Python DSPy script
   */
  private async callAgent(action: "design", payload: any): Promise<{
    libraryPulls: LibraryPull[];
    customConcepts: CustomConcept[];
    error?: string;
  }> {
    try {
        const pythonCmd = Deno.build.os === "windows" ? "python" : "python3";
        const scriptPath = "src/concepts/ConceptDesigning/dspy/main.py";

        const command = new Deno.Command(pythonCmd, {
            args: [scriptPath],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });

        const process = command.spawn();
        const writer = process.stdin.getWriter();
        
        await writer.write(new TextEncoder().encode(JSON.stringify({ action, payload })));
        await writer.close();

        const { stdout, stderr, success } = await process.output();
        const outputStr = new TextDecoder().decode(stdout);
        const errorStr = new TextDecoder().decode(stderr);

        if (!success) {
            console.error("DSPy script failed:", errorStr);
            return { 
                libraryPulls: [], 
                customConcepts: [], 
                error: "Internal design script error" 
            };
        }

        try {
            const result = JSON.parse(outputStr);
            if (result.error) {
                console.error("DSPy script returned error:", result.error);
                return { 
                    libraryPulls: [], 
                    customConcepts: [], 
                    error: result.error 
                };
            }
            return result;
        } catch (e) {
            console.error("Failed to parse DSPy output:", outputStr);
            console.error("Stderr:", errorStr);
            return { 
                libraryPulls: [], 
                customConcepts: [], 
                error: "Invalid response from designer" 
            };
        }

    } catch (error) {
      console.error("Failed to call DSPy designer:", error);
      return { 
          libraryPulls: [], 
          customConcepts: [], 
          error: "Failed to call DSPy designer" 
      };
    }
  }

  private async fetchLibrarySpecs(): Promise<string> {
    const headlessUrl = Deno.env.get("HEADLESS_URL");
    if (!headlessUrl) {
        console.warn("HEADLESS_URL not set, assuming no library concepts available.");
        return "";
    }

    try {
        let url = headlessUrl;
        if (url.endsWith("/")) {
            url = url.slice(0, -1);
        }
        url += "/api/specs";

        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to fetch specs from ${url}: ${response.statusText}`);
            return "";
        }
        return await response.text();
    } catch (error) {
        console.error("Error fetching library specs:", error);
        return "";
    }
  }

  /**
   * design (project: projectID, plan: Object) : (project: projectID, design: Design)
   *
   * **requires**: no design exists for project
   * **effects**: calls DSPy agent with plan + all library specs, stores result
   */
  async design({ project, plan }: {
    project: Project;
    plan: Record<string, any>;
  }): Promise<{
    project: Project;
    design?: DesignDoc;
  } | { error: string }> {
    const existing = await this.designs.findOne({ _id: project });
    if (existing) {
      return { error: "Design already exists for project" };
    }

    const availableConcepts = await this.fetchLibrarySpecs();

    // Call DSPy agent
    const result = await this.callAgent("design", {
      plan,
      available_concepts: availableConcepts,
    });

    if (result.error) {
        return { error: result.error };
    }

    const doc: DesignDoc = {
      _id: project,
      plan,
      libraryPulls: result.libraryPulls,
      customConcepts: result.customConcepts,
      status: "complete",
      createdAt: new Date(),
    };

    await this.designs.insertOne(doc);

    return {
      project,
      design: doc,
    };
  }

  /**
   * _getDesign(project: projectID) : (design: Design)
   */
  async _getDesign({ project }: { project: Project }): Promise<Array<{ design: DesignDoc }>> {
    const doc = await this.designs.findOne({ _id: project });
    if (!doc) return [];
    return [{ design: doc }];
  }
}

