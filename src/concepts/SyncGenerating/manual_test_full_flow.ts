
import "jsr:@std/dotenv/load";
import { testDb, freshID } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import PlanningConcept from "../Planning/PlanningConcept.ts";
import ConceptDesigningConcept from "../ConceptDesigning/ConceptDesigningConcept.ts";
import ImplementingConcept from "../Implementing/ImplementingConcept.ts";
import SyncGeneratingConcept from "../SyncGenerating/SyncGeneratingConcept.ts";

// Custom DB connection that preserves data between runs for this manual test
import { MongoClient } from "npm:mongodb";

async function persistentTestDb() {
    const DB_CONN = Deno.env.get("MONGODB_URL");
    const DB_NAME = Deno.env.get("DB_NAME");
    
    if (!DB_CONN || !DB_NAME) throw new Error("Missing DB env vars");
    
    const client = new MongoClient(DB_CONN);
    await client.connect();
    
    const test_DB_NAME = `test-meta-${DB_NAME}`;
    const db = client.db(test_DB_NAME);
    
    // NOTE: We do NOT drop collections here to allow caching/reuse of Plan & Design
    
    return [db, client] as const;
}

async function runFullFlow() {
    console.log("🚀 Starting Full Flow Test...");
    
    // 1. Setup DB
    console.log("📦 Connecting to Persistent Test DB...");
    const [db, client] = await persistentTestDb();
    
    // 2. Instantiate Concepts
    const planning = new PlanningConcept(db);
    const designing = new ConceptDesigningConcept(db);
    const implementing = new ImplementingConcept(db);
    const syncGenerating = new SyncGeneratingConcept(db);
    
    const projectId = "manual_test_fixed_id_v2";
    const appDescription = "A simple Todo app where users can create, complete, and delete tasks.";
    
    try {
        // 3. Planning
        console.log(`\n--- 📅 PLANNING (${projectId}) ---`);
        let plan = null;
        
        // Check if plan already exists
        const existingPlans = await planning._getPlan({ project: projectId });
        if (existingPlans.length > 0 && existingPlans[0].plan.status === "complete" && existingPlans[0].plan.plan) {
             console.log("✅ Using existing plan.");
             plan = existingPlans[0].plan.plan;
        } else {
            console.log(`Description: ${appDescription}`);
            
            if (existingPlans.length > 0) {
                console.log("Deleting existing incomplete plan...");
                // Directly delete from collection to ensure no "plan not found" race conditions
                await db.collection("Planning.plans").deleteOne({ _id: projectId });
            }
            
            const planResult = await planning.initiate({ project: projectId, description: appDescription });
            
            if ('error' in planResult) throw new Error(`Planning failed: ${planResult.error}`);
            if (planResult.status === "needs_clarification") {
                console.log("Needs clarification (mocking answer)...");
                if (planResult.questions) {
                     console.log("Questions:", planResult.questions);
                     throw new Error("Unexpected clarification needed for simple app");
                }
            }
            console.log("✅ Plan generated.");
            plan = planResult.plan;
        }
        
        // 4. Designing
        console.log(`\n--- 🎨 DESIGNING ---`);
        let design = null;
        
        const existingDesigns = await designing._getDesign({ project: projectId });
        if (existingDesigns.length > 0 && existingDesigns[0].design.status === "complete") {
            console.log("✅ Using existing design.");
            design = existingDesigns[0].design;
        } else {
            if (existingDesigns.length > 0) {
                console.log("Deleting existing incomplete design...");
                await db.collection("ConceptDesigning.designs").deleteOne({ _id: projectId });
            }
            
            const designResult = await designing.design({ project: projectId, plan: plan! });
            if ('error' in designResult) throw new Error(`Designing failed: ${designResult.error}`);
            
            console.log("✅ Design generated.");
            design = designResult.design;
        }
        
        console.log("Library Pulls:", design?.libraryPulls.length);
        console.log("Custom Concepts:", design?.customConcepts.length);

        // 5. Implementing
        console.log(`\n--- 🛠️ IMPLEMENTING ---`);
        let implementations = null;
        
        const existingImpls = await implementing._getImplementations({ project: projectId });
        // Check if implementations exist and are complete (we might need to check individual statuses but let's assume job existence implies some progress)
        // ImplJob doesn't strictly have a "complete" status for all, but let's check if the map is populated
        if (existingImpls.length > 0 && Object.keys(existingImpls[0].implementations).length > 0) {
             console.log("✅ Using existing implementations.");
             implementations = existingImpls[0].implementations;
        } else {
             // We verify if we need to delete failed job
             // implementing.implementAll checks existence
             // We don't have a delete method exposed on ImplementingConcept easily for the whole job? 
             // Actually ImplementingConcept has delete(project, conceptName).
             // But we can just try implementAll, it checks existence.
             // If it exists but is partial, we might want to re-run?
             // For now, if we found *any* implementation, we skip. If we want to force re-run, we'd need to clear DB.
             // Since we use a fixed ID, let's assume if we are here and didn't find good implementations, we need to run.
             // But implementAll will fail if job exists.
             // We need to delete the job if it exists but we want to re-run.
             // ImplementingConcept doesn't have a `deleteJob` method in the interface shown in `read_file`.
             // It has `delete({project, conceptName})`.
             // We can check `implJobs` directly if we had access, but we are outside.
             // Let's assume if `existingImpls` is empty, we run.
             // If it's not empty but we decided not to use it (e.g. empty map), we should probably skip or warn.
             
             // Wait, if `existingImpls` has entries but they are empty, we might be in a bad state.
             // Let's just run implementAll. If it fails because "Implementation job already exists", we should probably have deleted it manually or via a helper.
             // Since we don't have a clear "delete job" method, let's assume if we didn't pick up existing ones, we try to run.
             // But to be safe, if we found a job (even empty), we might need to skip or fail.
             // Let's just assume we only skip if we found valid implementations.
             
             if (existingImpls.length === 0) {
                const implResult = await implementing.implementAll({ project: projectId, design: design! });
                if ('error' in implResult) throw new Error(`Implementing failed: ${implResult.error}`);
                console.log("✅ Implementations generated.");
                implementations = implResult.implementations;
             } else {
                 console.log("⚠️ Implementation job exists but was not used. Re-using what is there to avoid error.");
                 implementations = existingImpls[0].implementations;
             }
        }
        
        // 6. Sync Generating
        console.log(`\n--- 🔄 SYNC GENERATING ---`);
        
        // Always force fresh sync generation for debugging purposes
        // Check if job exists and delete it (we don't have delete method exposed on concept class easily without checking DB directly or extending class)
        // Actually, let's just use the DB directly since we have it.
        const syncJobsColl = db.collection("SyncGenerating.syncJobs");
        await syncJobsColl.deleteOne({ _id: projectId });
        console.log("Deleted existing sync job to force regeneration.");
        
        // Prepare concept specs string for the agent
        let conceptSpecs = "";
        // For library pulls, we technically need their specs. Implementing pulled them.
        // Implementing stores spec in the implementation object.
        if (implementations) {
            for (const [name, impl] of Object.entries(implementations)) {
                conceptSpecs += `--- CONCEPT: ${name} ---\n${impl.spec}\n\n`;
            }
        }

        const syncResult = await syncGenerating.generate({ 
            project: projectId, 
            plan: plan!, 
            conceptSpecs, 
            implementations: implementations! 
        });
        
        if ('error' in syncResult) throw new Error(`Sync Generating failed: ${syncResult.error}`);
        
        console.log("✅ Syncs generated.");
        
        console.log("\n=== 📝 SAVING ARTIFACTS ===");
        
        // Ensure manual_tests directory exists
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        // Fix: Use Deno's path module for cross-platform compatibility
        const { fromFileUrl, join, dirname } = await import("jsr:@std/path");
        const currentDir = dirname(fromFileUrl(import.meta.url));
        const testDir = join(currentDir, "manual_tests", timestamp);
        
        try {
            await Deno.mkdir(testDir, { recursive: true });
            
            // 1. Save API Definition
            const apiPath = join(testDir, "openapi.yaml");
            await Deno.writeTextFile(apiPath, syncResult.apiDefinition.content);
            console.log(`Saved API Definition to ${apiPath}`);
            
            // 2. Save Endpoint Bundles
            for (let i = 0; i < syncResult.endpointBundles.length; i++) {
                const bundle = syncResult.endpointBundles[i];
                const method = bundle.endpoint.method.toLowerCase();
                const pathName = bundle.endpoint.path.replace(/\//g, "_").replace(/[{}]/g, "");
                const bundleDir = join(testDir, `${method}${pathName}`);
                
                await Deno.mkdir(bundleDir, { recursive: true });
                
                // Save Syncs JSON
                await Deno.writeTextFile(
                    join(bundleDir, "syncs.json"), 
                    JSON.stringify(bundle.syncs, null, 2)
                );
                
                // Save Test File
                await Deno.writeTextFile(
                    join(bundleDir, "endpoint.test.ts"),
                    bundle.testFile
                );
                
                // Save Endpoint Info
                await Deno.writeTextFile(
                    join(bundleDir, "endpoint.json"),
                    JSON.stringify(bundle.endpoint, null, 2)
                );
                
                console.log(`Saved bundle for ${bundle.endpoint.method} ${bundle.endpoint.path}`);
            }
            
            console.log(`\nArtifacts saved to: ${testDir}`);
            
        } catch (err) {
            console.error("Failed to save artifacts:", err);
        }
        
        console.log("\n=== 📝 OUTPUT REPORT ===");
        
        console.log("\n--- API Definition ---");
        console.log(syncResult.apiDefinition.content);
        
        console.log("\n--- Endpoint Bundles ---");
        for (const bundle of syncResult.endpointBundles) {
            console.log(`\nEndpoint: ${bundle.endpoint.method} ${bundle.endpoint.path}`);
            console.log(`Test Compile Status: ${bundle.compile?.ok ? "OK" : "FAILED"}`);
            if (bundle.compile?.errors) console.log("Errors:", bundle.compile.errors);
            
            console.log("Syncs:");
            console.log(JSON.stringify(bundle.syncs, null, 2));
            
            console.log("Test File (Preview):");
            console.log(bundle.testFile.substring(0, 500) + "...");
        }

    } catch (e) {
        console.error("\n❌ TEST FAILED:", e);
    } finally {
        await client.close();
    }
}

runFullFlow();
