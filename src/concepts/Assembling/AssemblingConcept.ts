import { Binary, Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import { exists } from "https://deno.land/std@0.224.0/fs/exists.ts";

const PREFIX = "Assembling.";

type Project = ID;

export interface AssemblyDoc {
  _id: Project;
  downloadUrl: string;
  zipData: Binary;  // Store ZIP directly as Binary (max 16MB, plenty for generated code)
  status: "assembling" | "complete" | "error";
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @concept Assembling
 * @purpose Package all generated code into a downloadable, runnable project.
 */
export default class AssemblingConcept {
  public readonly assemblies: Collection<AssemblyDoc>;

  constructor(private readonly db: Db) {
    this.assemblies = this.db.collection<AssemblyDoc>(PREFIX + "assemblies");
  }

  private async callAgent(action: string, payload: any): Promise<{ markdown: string } | { error: string }> {
    try {
      const pythonCmd = Deno.build.os === "windows" ? "python" : "python3";
      const scriptPath = "src/concepts/Assembling/dspy/main.py";

      const command = new Deno.Command(pythonCmd, {
        args: [scriptPath],
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",  // Inherit so debug output streams to console in real-time
        env: {
            "PYTHONDONTWRITEBYTECODE": "1"
        }
      });

      console.log(`[AssemblingConcept] Spawning python: ${pythonCmd} ${scriptPath}`);
      const process = command.spawn();
      const writer = process.stdin.getWriter();
      
      console.log(`[AssemblingConcept] Writing payload...`);
      await writer.write(new TextEncoder().encode(JSON.stringify({ action, payload })));
      await writer.close();
      console.log(`[AssemblingConcept] Payload written & stdin closed.`);

      const { stdout, success } = await process.output();
      const outputStr = new TextDecoder().decode(stdout);
      
      console.log(`[AssemblingConcept] Process finished. Success: ${success}`);

      if (!success) {
        console.error("Internal assembling agent error (see stderr above)");
        return { error: "Internal assembling agent error - see console for details" };
      }

      try {
        const result = JSON.parse(outputStr);
        if (result.error) {
            return { error: result.error };
        }
        return result;
      } catch (e) {
        return { error: "Invalid response from assembling agent" };
      }

    } catch (error) {
      console.error("Failed to call DSPy assembling agent:", error);
      return { error: "Failed to call DSPy assembling agent" };
    }
  }

  /**
   * Helper to copy a file
   */
  private async copyFile(src: string, dest: string) {
    try {
        if (await exists(src)) {
            await Deno.copyFile(src, dest);
        } else {
            console.warn(`Source file not found: ${src}`);
        }
    } catch (e) {
        console.error(`Failed to copy ${src} to ${dest}:`, e);
    }
  }

  /**
   * Helper to copy a directory recursively
   */
  private async copyDir(src: string, dest: string) {
    try {
        // Ensure dest exists
        await Deno.mkdir(dest, { recursive: true });
        
        for await (const entry of Deno.readDir(src)) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory) {
                await this.copyDir(srcPath, destPath);
            } else {
                await Deno.copyFile(srcPath, destPath);
            }
        }
    } catch (e) {
        console.error(`Failed to copy dir ${src} to ${dest}:`, e);
    }
  }

  async assemble({ project, plan, implementations, syncs }: {
    project: Project;
    plan: any;
    implementations: Record<string, any>;
    syncs: { syncs: any[]; apiDefinition: any; endpointBundles: any[] };
  }): Promise<{ project: Project; downloadUrl: string } | { error: string }> {
    console.log("[Assembling.assemble] Called for project:", project);
    const existing = await this.assemblies.findOne({ _id: project });
    if (existing) {
        // We could overwrite, but for now let's return existing
        console.log("[Assembling.assemble] Returning existing assembly:", existing.downloadUrl);
        return { project, downloadUrl: existing.downloadUrl };
    }
    console.log("[Assembling.assemble] No existing assembly, starting fresh...");

    const tempDir = await Deno.makeTempDir({ prefix: `assembly_${project}_` });
    const projectDir = path.join(tempDir, "conceptual-app");
    await Deno.mkdir(projectDir);

    try {
        console.log("[Assembling] Starting assembly...");
        // 1. Copy static files
        const cwd = Deno.cwd();
        console.log("[Assembling] Copying static files...");
        // Use the clean templates (without dev-specific tasks like dyad-install)
        const templateDir = path.join(cwd, "src/concepts/Assembling/templates");
        await this.copyFile(path.join(templateDir, "deno.json"), path.join(projectDir, "deno.json"));
        await this.copyFile(path.join(templateDir, ".env.template"), path.join(projectDir, ".env.template"));
        await this.copyFile(path.join(cwd, "Dockerfile"), path.join(projectDir, "Dockerfile"));
        
        // Create src structure
        await Deno.mkdir(path.join(projectDir, "src"), { recursive: true });
        await this.copyFile(path.join(cwd, "src/main.ts"), path.join(projectDir, "src/main.ts"));
        await this.copyFile(path.join(cwd, "src/concept_server.ts"), path.join(projectDir, "src/concept_server.ts"));
        
        await this.copyDir(path.join(cwd, "src/utils"), path.join(projectDir, "src/utils"));
        await this.copyDir(path.join(cwd, "src/engine"), path.join(projectDir, "src/engine"));

        // 2. Write Concepts
        console.log("[Assembling] Writing concepts...");
        const conceptsDir = path.join(projectDir, "src/concepts");
        await Deno.mkdir(conceptsDir, { recursive: true });

        // 2b. Copy Requesting Concept
        const requestingSrc = path.join(cwd, "src/concepts/Requesting");
        const requestingDest = path.join(conceptsDir, "Requesting");
        await this.copyDir(requestingSrc, requestingDest);

        for (const [name, impl] of Object.entries(implementations)) {
            const conceptDir = path.join(conceptsDir, name);
            await Deno.mkdir(conceptDir, { recursive: true });
            
            await Deno.writeTextFile(path.join(conceptDir, `${name}Concept.ts`), impl.code);
            await Deno.writeTextFile(path.join(conceptDir, `${name}.test.ts`), impl.tests);
            await Deno.writeTextFile(path.join(conceptDir, `${name}.md`), impl.spec);
        }

        // Note: We rely on 'deno task build' (generate_imports.ts) to generate concepts.ts and syncs.ts
        // So we do not need to write src/concepts/index.ts manually.
        // However, for the project to be immediately usable/inspectable before build, 
        // we might want to run the generation or provide instructions.
        // The user explicitly requested to rely on 'deno task build'.

        // 3. Validate and Write Syncs
        console.log("[Assembling] Validating sync files...");
        const syncsDir = path.join(projectDir, "src/syncs");
        await Deno.mkdir(syncsDir, { recursive: true });

        // First, validate all endpoints have sync files
        const missingSyncs: string[] = [];
        for (const bundle of syncs.endpointBundles) {
            const endpoint = bundle.endpoint;
            if (!bundle.syncFile || !bundle.syncFile.trim()) {
                missingSyncs.push(`${endpoint.method} ${endpoint.path}`);
            }
        }

        if (missingSyncs.length > 0) {
            console.error("[Assembling] ERROR: The following endpoints are missing sync files:");
            for (const ep of missingSyncs) {
                console.error(`  - ${ep}`);
            }
            console.error("[Assembling] These endpoints will NOT work. Re-run sync generation to fix.");
            // We log the error but continue - the user should be aware of missing syncs
            // Alternatively, we could return an error here to fail hard:
            // return { error: `Missing sync files for endpoints: ${missingSyncs.join(", ")}` };
        }

        console.log("[Assembling] Writing syncs...");
        // Write each endpoint bundle's sync file
        let syncsWritten = 0;
        for (let i = 0; i < syncs.endpointBundles.length; i++) {
            const bundle = syncs.endpointBundles[i];
            if (bundle.syncFile && bundle.syncFile.trim()) {
                const endpoint = bundle.endpoint;
                // Generate a safe filename from method and path
                const safePath = endpoint.path.replace(/[^a-zA-Z0-9]/g, "_");
                const syncFileName = `${endpoint.method.toLowerCase()}${safePath}.sync.ts`;
                await Deno.writeTextFile(path.join(syncsDir, syncFileName), bundle.syncFile);
                syncsWritten++;
            }
        }
        console.log(`[Assembling] Wrote ${syncsWritten}/${syncs.endpointBundles.length} sync files.`);

        // 4. Write Tests (Endpoint Bundles)
        console.log("[Assembling] Writing tests...");
        const testsDir = path.join(projectDir, "src/tests");
        await Deno.mkdir(testsDir, { recursive: true });
        
        for (let i = 0; i < syncs.endpointBundles.length; i++) {
            const bundle = syncs.endpointBundles[i];
            const testFileName = `endpoint_${i}.test.ts`;
            await Deno.writeTextFile(path.join(testsDir, testFileName), bundle.testFile);
        }

        // 5. OpenAPI
        console.log("[Assembling] Writing OpenAPI...");
        const openApiYaml = syncs.apiDefinition.content;
        await Deno.writeTextFile(path.join(projectDir, "openapi.yaml"), openApiYaml);

        // 6. Generate Documentation
        // README.md — give the agent rich background context
        const techStack = `
- Runtime: Deno (TypeScript)
- Database: MongoDB
- Architecture: Concept + Sync pattern (modular concepts wired by synchronization files)
- HTTP Framework: Hono (via Requesting concept)
- AI Runtime: Shared local helper in src/utils/ai.ts with env-configured provider/model selection
- Container: Docker (Dockerfile included)

## Setup
1. Install Deno (https://deno.land)
2. Copy .env.template to .env and fill in values (MongoDB, auth, and AI settings if your app uses AI-backed concepts).
3. Run \`deno task build\` to generate import files (concepts.ts, syncs.ts).
4. Run \`deno task start\` to launch the server.
5. Run \`deno task test\` to run endpoint tests.
`;

        // Load background docs for richer README content
        const backgroundFiles = [
            "design/background/architecture.md",
            "design/background/concept-design-brief.md",
            "design/background/implementing-synchronizations.md",
        ];
        const backgroundParts: string[] = [];
        for (const bgFile of backgroundFiles) {
            const bgPath = path.join(cwd, bgFile);
            try {
                if (await exists(bgPath)) {
                    const content = await Deno.readTextFile(bgPath);
                    backgroundParts.push(`--- ${bgFile} ---\n${content}`);
                }
            } catch {
                // skip missing files
            }
        }

        // Include deno.json template so the agent knows about tasks and imports
        const denoJsonPath = path.join(cwd, "src/concepts/Assembling/templates/deno.json");
        try {
            if (await exists(denoJsonPath)) {
                const denoJsonContent = await Deno.readTextFile(denoJsonPath);
                backgroundParts.push(`--- deno.json (project config) ---\n${denoJsonContent}`);
            }
        } catch {}

        const generatedEnvTemplatePath = path.join(cwd, "src/concepts/Assembling/templates/.env.template");
        try {
            if (await exists(generatedEnvTemplatePath)) {
                const envTemplateContent = await Deno.readTextFile(generatedEnvTemplatePath);
                backgroundParts.push(`--- generated backend .env.template ---\n${envTemplateContent}`);
            }
        } catch {}

        const sharedAiHelperPath = path.join(cwd, "src/utils/ai.ts");
        try {
            if (await exists(sharedAiHelperPath)) {
                const aiHelperContent = await Deno.readTextFile(sharedAiHelperPath);
                backgroundParts.push(`--- shared AI helper (src/utils/ai.ts) ---\n${aiHelperContent}`);
            }
        } catch {}

        // Include concept names and their specs for the concepts section
        const conceptSummaries: string[] = [];
        for (const [name, impl] of Object.entries(implementations)) {
            conceptSummaries.push(`### ${name}\n${(impl as any).spec}`);
        }
        if (conceptSummaries.length > 0) {
            backgroundParts.push(`--- Concept Specifications ---\n${conceptSummaries.join("\n\n")}`);
        }

        const backgroundContext = backgroundParts.join("\n\n");

        const readmeResult = await this.callAgent("generate_readme", {
            plan: plan,
            endpoints: syncs.endpointBundles.map((b: any) => b.endpoint),
            tech_stack: techStack,
            background_context: backgroundContext
        });
        if (!("error" in readmeResult)) {
             await Deno.writeTextFile(path.join(projectDir, "README.md"), readmeResult.markdown);
        } else {
             await Deno.writeTextFile(path.join(projectDir, "README.md"), "# Project\n\nGeneration failed.");
        }

        // 7. Zip
        const zip = new JSZip();
        
        // Use flat paths relative to projectDir for reliability
        const addDirToZip = async (dir: string, basePath: string = "") => {
            for await (const entry of Deno.readDir(dir)) {
                const fullPath = path.join(dir, entry.name);
                const zipPath = basePath ? `${basePath}/${entry.name}` : entry.name;
                
                if (entry.isDirectory) {
                    await addDirToZip(fullPath, zipPath);
                } else {
                    const content = await Deno.readFile(fullPath);
                    zip.file(zipPath, content);
                    console.log(`[Assembling] Added to zip: ${zipPath}`);
                }
            }
        };

        console.log("[Assembling] Creating zip from:", projectDir);
        await addDirToZip(projectDir);

        const zipContent = await zip.generateAsync({ type: "uint8array" });
        
        // 8. Store ZIP as Binary in document (no GridFS needed for small files)
        const downloadUrl = `/api/downloads/${project}.zip`;

        const doc: AssemblyDoc = {
            _id: project,
            downloadUrl,
            zipData: new Binary(zipContent),
            status: "complete",
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await this.assemblies.insertOne(doc);

        return { project, downloadUrl };

    } catch (e) {
        console.error("Assembly failed:", e);
        return { error: String(e) };
    } finally {
        // Cleanup temp dir
        try {
            await Deno.remove(tempDir, { recursive: true });
        } catch {}
    }
  }

  async getFileStream({ project }: { project: Project }): Promise<ReadableStream<Uint8Array> | null> {
    const doc = await this.assemblies.findOne({ _id: project });
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
      const doc = await this.assemblies.findOne({ _id: project });
      if (!doc) return { downloadUrl: "" };
      return { downloadUrl: doc.downloadUrl };
  }

  /**
   * deleteProject (project: projectID) : (deleted: Number)
   * effects: deletes assembled backend artifacts for a project
   */
  async deleteProject({ project }: { project: Project }): Promise<{ deleted: number }> {
    const result = await this.assemblies.deleteOne({ _id: project });
    return { deleted: result.deletedCount };
  }
}
