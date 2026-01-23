import { Collection, Db } from "npm:mongodb";
import { Empty, ID } from "@utils/types.ts";

const PREFIX = "Implementing.";

// Generic types
type Project = ID;

export interface Implementation {
  code: string;
  tests: string;
  spec: string;
  status: "complete" | "error" | "pending";
  iterations: number;
}

/**
 * State:
 * a set of ImplJobs with
 *   a project ID
 *   a design Design
 *   a implementations Map<String, { code: String, tests: String, spec: String, status: String, iterations: Number }>
 *   a status String
 */
export interface ImplJobDoc {
  _id: Project;
  design: any; // We can use the DesignDoc type if available, or just any for now
  implementations: Record<string, Implementation>;
  status: "processing" | "complete" | "error";
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Implementing
 * @purpose Generate TypeScript implementations and comprehensive tests for concepts, with automated fixing.
 */
export default class ImplementingConcept {
  public readonly implJobs: Collection<ImplJobDoc>;

  constructor(private readonly db: Db) {
    this.implJobs = this.db.collection<ImplJobDoc>(PREFIX + "implJobs");
  }

  /**
   * Helper to call the Python DSPy script
   */
  private async callAgent(action: string, payload: any): Promise<any> {
    try {
        const pythonCmd = Deno.build.os === "windows" ? "python" : "python3";
        const scriptPath = "src/concepts/Implementing/dspy/main.py";

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
        
        await writer.write(new TextEncoder().encode(JSON.stringify({ action, payload })));
        await writer.close();

        const { stdout, success } = await process.output();
        const outputStr = new TextDecoder().decode(stdout);
        // stderr is inherited so it goes to console directly
        const errorStr = "";

        if (!success) {
            console.error("DSPy script failed:", errorStr);
            return { error: "Internal implementation script error" };
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
            return { error: "Invalid response from implementer" };
        }

    } catch (error) {
      console.error("Failed to call DSPy implementer:", error);
      return { error: "Failed to call DSPy implementer" };
    }
  }

  private async pullLibraryConcept(libraryName: string): Promise<Implementation> {
    const headlessUrl = Deno.env.get("HEADLESS_URL");
    if (!headlessUrl) {
        throw new Error("HEADLESS_URL not set");
    }

    let url = headlessUrl;
    if (url.endsWith("/")) {
        url = url.slice(0, -1);
    }
    url += `/api/pull/${libraryName}`;

    const response = await fetch(url, { method: "POST" });
    if (!response.ok) {
        throw new Error(`Failed to pull concept ${libraryName}: ${response.statusText}`);
    }

    const files = await response.json();
    
    // Use code as is
    const code = files.code;

    return {
        code,
        tests: files.tests,
        spec: files.spec,
        status: "complete",
        iterations: 0
    };
  }

  private async runTests(code: string, tests: string, conceptName: string): Promise<{ success: boolean; errors?: string }> {
     // Create a temp directory
     const tempDir = await Deno.makeTempDir();
     try {
         // Write files
         await Deno.writeTextFile(`${tempDir}/${conceptName}Concept.ts`, code);
         await Deno.writeTextFile(`${tempDir}/${conceptName}.test.ts`, tests);
         
         // Helper to write minimal dependencies if needed (mock types, etc.)
         await this.writeTestDependencies(tempDir);

         const command = new Deno.Command("deno", {
             args: ["test", "--allow-all", `${tempDir}/${conceptName}.test.ts`],
             cwd: tempDir, // Run in temp dir
             stdout: "piped",
             stderr: "piped",
             env: {
                 // Use a unique DB name to avoid wiping the main test database
                 "DB_NAME": `gen_${conceptName.slice(0, 10)}_${crypto.randomUUID().split("-")[0].slice(0, 6)}`
             }
         });

         const { success, stderr, stdout } = await command.output();
         const errorOutput = new TextDecoder().decode(stderr);
         const stdOutput = new TextDecoder().decode(stdout);

         return {
             success,
             errors: success ? undefined : errorOutput + "\n" + stdOutput
         };

     } catch (e) {
         return { success: false, errors: String(e) };
     } finally {
         // Cleanup
         try {
             await Deno.remove(tempDir, { recursive: true });
         } catch {
             // ignore cleanup errors
         }
     }
  }

  private async writeTestDependencies(dir: string) {
      // We need to map @utils to the real project utils to avoid mocking drift
      // Get absolute path to src/utils
      const cwd = Deno.cwd();
      // On Windows, paths might need conversion to file URL
      // Ensure forward slashes and proper file:/// prefix
      let utilsPath = `${cwd}/src/utils/`.replace(/\\/g, "/");
      if (!utilsPath.startsWith("/")) {
          utilsPath = "/" + utilsPath;
      }
      const utilsUri = `file://${utilsPath}`;

      const denoJson = {
          imports: {
              "@utils/": utilsUri,
              "npm:": "npm:",
              "jsr:": "jsr:"
          }
      };
      await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify(denoJson));
  }

  private async implementCustomConcept(conceptName: string, spec: string): Promise<Implementation> {
    const maxIterations = 3;
    
    // 1. Generate initial implementation
    let result = await this.callAgent("implement", { spec, conceptName });
    if (result.error) return { code: "", tests: "", spec, status: "error", iterations: 0 };
    
    // If the agent successfully implemented and verified the concept, return it immediately.
    if (result.status === "complete") {
      return {
        code: result.code,
        tests: result.tests,
        spec,
        status: "complete",
        iterations: result.iterations
      };
    }

    let code = result.code;
    
    // 2. Generate tests
    // Only generate new tests if the previous step didn't provide valid ones or failed
    if (!result.tests) {
        result = await this.callAgent("generateTests", { spec, code, conceptName });
        if (result.error) return { code, tests: "", spec, status: "error", iterations: 0 };
    }
    let tests = result.tests;

    // 3. Fix loop
    for (let i = 0; i < maxIterations; i++) {
      const testResult = await this.runTests(code, tests, conceptName);
      
      if (testResult.success) {
        return { code, tests, spec, status: "complete", iterations: i + 1 };
      }
      
      console.log(`[Implementing] Tests failed for ${conceptName} (Iteration ${i+1}):`);
      console.log(testResult.errors);

      result = await this.callAgent("fix", { spec, code, tests, errors: testResult.errors });
      if (result.error) break; // If fix fails, we stop
      code = result.code; // Update code (and potentially tests if the agent updates them, but simple fix usually updates code)
    }
    
    return { code, tests, spec, status: "error", iterations: maxIterations };
  }

  /**
   * implementAll (project: projectID, design: Design) : (project: projectID, implementations: Object)
   */
  async implementAll({ project, design }: {
    project: Project;
    design: any; // DesignDoc
  }): Promise<{
    project: Project;
    implementations?: Record<string, Implementation>;
  } | { error: string }> {
    const existing = await this.implJobs.findOne({ _id: project });
    if (existing) {
      return { error: "Implementation job already exists for project" };
    }

    const implementations: Record<string, Implementation> = {};

    // 1. Library Pulls
    for (const pull of design.libraryPulls) {
        try {
            const impl = await this.pullLibraryConcept(pull.libraryName);
            implementations[pull.libraryName] = impl;
        } catch (e) {
            console.error(`Failed to pull library concept ${pull.libraryName}:`, e);
            // We might want to continue or fail hard. For now fail hard to ensure integrity.
            return { error: `Failed to pull library concept ${pull.libraryName}` };
        }
    }

    // 2. Custom Concepts
    for (const custom of design.customConcepts) {
        const impl = await this.implementCustomConcept(custom.name, custom.spec);
        implementations[custom.name] = impl;
    }

    const doc: ImplJobDoc = {
      _id: project,
      design,
      implementations,
      status: "complete", // Simplified: assuming synchronous completion for now
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.implJobs.insertOne(doc);

    return {
      project,
      implementations,
    };
  }

  /**
   * change (project: projectID, conceptName: String, feedback: String) : (project: projectID, implementations: Object)
   */
  async change({ project, conceptName, feedback }: {
      project: Project;
      conceptName: string;
      feedback: string;
  }): Promise<{
      project: Project;
      implementations?: Record<string, Implementation>;
  } | { error: string }> {
      const job = await this.implJobs.findOne({ _id: project });
      if (!job) {
          return { error: "Implementation job does not exist" };
      }

      const currentImpl = job.implementations[conceptName];
      if (!currentImpl) {
          return { error: `Concept ${conceptName} not found in project` };
      }

      // Re-run implementation loop with feedback
      // We treat feedback as a modification request. 
      // We can use the 'fix' agent or a 'modify' agent. 
      // Using 'fix' signature might be enough if we pass feedback as "errors" or add a feedback field.
      // Or we call "implement" again with updated spec if the feedback implies spec change?
      // Assuming feedback is about implementation details, we can try to "fix" it.
      
      // Let's assume we use the fix loop but seed it with the feedback as the "error" or instruction
      // Ideally we would have a specific "modifyImplementation" signature.
      // For simplicity, let's reuse the fix loop logic but passing feedback.
      
      const maxIterations = 3;
      let code = currentImpl.code;
      let tests = currentImpl.tests;
      let spec = currentImpl.spec;

      // Initial fix attempt with feedback
      let result = await this.callAgent("fix", { spec, code, tests, errors: feedback });
      if (result.error) return { error: result.error };
      code = result.code;

      // Verify with tests
      for (let i = 0; i < maxIterations; i++) {
        const testResult = await this.runTests(code, tests, conceptName);
        if (testResult.success) {
            // Update MongoDB
            job.implementations[conceptName] = {
                code,
                tests,
                spec,
                status: "complete",
                iterations: currentImpl.iterations + i + 1
            };
            await this.implJobs.updateOne({ _id: project }, { $set: { implementations: job.implementations, updatedAt: new Date() } });
            
            return { project, implementations: job.implementations };
        }
        
        result = await this.callAgent("fix", { spec, code, tests, errors: testResult.errors });
        if (result.error) break;
        code = result.code;
      }

      // If we fall through, it failed
      job.implementations[conceptName] = {
          code,
          tests,
          spec,
          status: "error",
          iterations: currentImpl.iterations + maxIterations
      };
      await this.implJobs.updateOne({ _id: project }, { $set: { implementations: job.implementations, updatedAt: new Date() } });

      return { project, implementations: job.implementations };
  }

  /**
   * delete (project: projectID, conceptName: String) : (project: projectID, implementations: Object)
   */
  async delete({ project, conceptName }: {
      project: Project;
      conceptName: string;
  }): Promise<{
      project: Project;
      implementations?: Record<string, Implementation>;
  } | { error: string }> {
      const job = await this.implJobs.findOne({ _id: project });
      if (!job) {
          return { error: "Implementation job does not exist" };
      }

      if (!job.implementations[conceptName]) {
          return { error: `Concept ${conceptName} not found` };
      }

      delete job.implementations[conceptName];

      await this.implJobs.updateOne(
          { _id: project },
          { $set: { implementations: job.implementations, updatedAt: new Date() } }
      );

      return { project, implementations: job.implementations };
  }

  /**
   * _getImplementations(project: projectID) : (implementations: Object)
   */
  async _getImplementations({ project }: { project: Project }): Promise<Array<{ implementations: Record<string, Implementation> }>> {
      const job = await this.implJobs.findOne({ _id: project });
      if (!job) return [];
      return [{ implementations: job.implementations }];
  }
}
