
import "jsr:@std/dotenv/load";
import { MongoClient } from "npm:mongodb";
import { fromFileUrl, join, dirname } from "jsr:@std/path";

async function saveArtifacts() {
    console.log("📦 Connecting to DB...");
    const DB_CONN = Deno.env.get("MONGODB_URL");
    const DB_NAME = Deno.env.get("DB_NAME");
    
    if (!DB_CONN || !DB_NAME) throw new Error("Missing DB env vars");
    
    const client = new MongoClient(DB_CONN);
    await client.connect();
    
    // Use the meta DB where the job is stored
    const test_DB_NAME = `test-meta-${DB_NAME}`;
    const db = client.db(test_DB_NAME);
    
    const projectId = "manual_test_fixed_id_v2";
    
    try {
        console.log(`Fetching sync job for project: ${projectId}`);
        const job = await db.collection("SyncGenerating.syncJobs").findOne({ _id: projectId });
        
        if (!job) {
            throw new Error("Sync job not found. Did the test run successfully?");
        }
        
        console.log("✅ Found sync job.");
        
        // Setup output directory using proper path handling
        const currentDir = dirname(fromFileUrl(import.meta.url));
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outputDir = join(currentDir, "manual_tests", timestamp);
        
        console.log(`Saving artifacts to: ${outputDir}`);
        await Deno.mkdir(outputDir, { recursive: true });
        
        // 1. Save API Definition
        const apiPath = join(outputDir, "openapi.yaml");
        await Deno.writeTextFile(apiPath, job.apiDefinition.content);
        console.log(`Saved API Definition to ${apiPath}`);
        
        // 2. Save Endpoint Bundles
        for (const bundle of job.endpointBundles) {
            const method = bundle.endpoint.method.toLowerCase();
            const pathName = bundle.endpoint.path.replace(/\//g, "_").replace(/[{}]/g, "");
            const bundleDir = join(outputDir, `${method}${pathName}`);
            
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
        
        console.log("\n✅ Done! Artifacts saved successfully.");
        
    } catch (e) {
        console.error("Error saving artifacts:", e);
    } finally {
        await client.close();
    }
}

saveArtifacts();
