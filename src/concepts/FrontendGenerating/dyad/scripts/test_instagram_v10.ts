/**
 * Test script for the frontend generation review/fix loop.
 *
 * Connects to MongoDB, fetches the "Instagram V10" project data
 * (plan, API definition, app graph, OpenAPI YAML), and runs
 * generate_frontend.ts with the real project inputs.
 *
 * Run from the dyad directory:
 *   npx ts-node scripts/test_instagram_v10.ts
 *
 * Output goes to: dyad/out/test_instagram_v10/
 * Review results: dyad/out/test_instagram_v10/review_results.json
 */
import { MongoClient } from "mongodb";
import * as dotenv from "dotenv";
import * as path from "path";
import fs from "fs-extra";
import { spawn } from "child_process";

// Load .env from repo root (4 dirs up from scripts/)
dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });

async function main() {
    const MONGODB_URL = process.env.MONGODB_URL;
    const DB_NAME = process.env.DB_NAME;

    if (!MONGODB_URL || !DB_NAME) {
        console.error("Missing MONGODB_URL or DB_NAME in .env");
        process.exit(1);
    }

    console.log("=== Frontend Generation Test: Instagram V10 ===\n");
    console.log(`Connecting to MongoDB (db: ${DB_NAME})...`);

    const client = new MongoClient(MONGODB_URL);
    await client.connect();
    const db = client.db(DB_NAME);
    console.log("Connected.\n");

    // ── 1. Find the project ──────────────────────────────────────────
    console.log('Looking for "Instagram V10" in ProjectLedger.projects...');
    const project = await db.collection("ProjectLedger.projects").findOne({ name: "Instagram V10" });
    if (!project) {
        console.error('ERROR: Project "Instagram V10" not found!');
        console.log("Available projects:");
        const all = await db.collection("ProjectLedger.projects").find({}).toArray();
        for (const p of all) {
            console.log(`  - "${p.name}" (id: ${p._id}, status: ${p.status})`);
        }
        await client.close();
        process.exit(1);
    }
    console.log(`  Found: id=${project._id}, status=${project.status}\n`);

    // ── 2. Fetch the plan ────────────────────────────────────────────
    console.log("Fetching plan from Planning.plans...");
    const planDoc = await db.collection("Planning.plans").findOne({ _id: project._id });
    if (!planDoc?.plan) {
        console.error("ERROR: Plan not found for this project!");
        await client.close();
        process.exit(1);
    }
    const planStr = JSON.stringify(planDoc.plan);
    console.log(`  Plan loaded (${planStr.length} chars)\n`);

    // ── 3. Fetch sync data (API definition + app graph) ──────────────
    console.log("Fetching sync data from SyncGenerating.syncJobs...");
    const syncJob = await db.collection("SyncGenerating.syncJobs").findOne({ _id: project._id });
    if (!syncJob?.apiDefinition) {
        console.error("ERROR: SyncGenerating.syncJobs not found or missing apiDefinition!");
        await client.close();
        process.exit(1);
    }
    const apiDef = syncJob.apiDefinition;
    console.log(`  OpenAPI YAML content: ${apiDef.content?.length || 0} chars`);
    console.log(`  App Graph JSON:       ${apiDef.appGraph?.length || 0} chars`);
    console.log(`  Endpoints array:      ${apiDef.endpoints?.length || 0} entries\n`);

    await client.close();
    console.log("MongoDB connection closed.\n");

    // ── 4. Write temp input files ────────────────────────────────────
    const tempDir = path.join(__dirname, "../out/_test_temp");
    fs.ensureDirSync(tempDir);

    const planPath = path.join(tempDir, "plan.json");
    const apiSpecPath = path.join(tempDir, "api_spec.json");
    const appGraphPath = path.join(tempDir, "app_graph.json");
    const openapiYamlPath = path.join(tempDir, "openapi.yaml");

    fs.writeFileSync(planPath, planStr);
    fs.writeFileSync(apiSpecPath, JSON.stringify(apiDef));

    if (apiDef.appGraph) {
        fs.writeFileSync(appGraphPath, apiDef.appGraph);
        console.log("Wrote app_graph.json");
    } else {
        console.warn("WARNING: No appGraph found in apiDefinition. Review loop will be skipped.");
    }
    if (apiDef.content) {
        fs.writeFileSync(openapiYamlPath, apiDef.content);
        console.log("Wrote openapi.yaml");
    }
    console.log(`Temp input files written to: ${tempDir}\n`);

    // ── 5. Spawn generate_frontend.ts ────────────────────────────────
    const projectName = "test_instagram_v10";
    const scriptPath = path.join(__dirname, "generate_frontend.ts");
    const cwd = path.join(__dirname, "..");

    const npxArgs = [
        "-y", "ts-node", scriptPath, projectName,
        `--plan-file=${planPath}`,
        `--api-file=${apiSpecPath}`,
    ];
    if (apiDef.content) {
        npxArgs.push(`--openapi-yaml-file=${openapiYamlPath}`);
    }
    if (apiDef.appGraph) {
        npxArgs.push(`--app-graph-file=${appGraphPath}`);
    }

    const outDir = path.join(cwd, "out", projectName);
    console.log("=".repeat(70));
    console.log(`  Project name : ${projectName}`);
    console.log(`  Output dir   : ${outDir}`);
    console.log(`  Script       : ${scriptPath}`);
    console.log(`  CWD          : ${cwd}`);
    console.log("=".repeat(70));
    console.log("\nStarting generation...\n");

    const startTime = Date.now();

    // Spawn with streaming output so we see debug prints in real-time
    const child = spawn("npx", npxArgs, {
        cwd,
        env: {
            ...process.env,
            // Ensure all relevant env vars are inherited (dotenv already loaded them)
        },
        shell: true, // needed on Windows for npx.cmd
        stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout!.on("data", (data: Buffer) => process.stdout.write(data));
    child.stderr!.on("data", (data: Buffer) => process.stderr.write(data));

    const exitCode = await new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1));
    });

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n${"=".repeat(70)}`);
    console.log(`  Generation finished in ${elapsedSec}s — exit code ${exitCode}`);
    console.log(`  Output directory: ${outDir}`);
    console.log(`${"=".repeat(70)}\n`);

    // ── 6. Cleanup temp files ────────────────────────────────────────
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("Temp input files cleaned up.\n");

    // ── 7. Print review results summary ──────────────────────────────
    const reviewResultsPath = path.join(outDir, "review_results.json");
    if (fs.existsSync(reviewResultsPath)) {
        try {
            const results = JSON.parse(fs.readFileSync(reviewResultsPath, "utf-8"));
            console.log("╔══════════════════════════════════════════╗");
            console.log("║        REVIEW RESULTS SUMMARY            ║");
            console.log("╚══════════════════════════════════════════╝");
            console.log(`  Iterations run : ${results.iterations}`);
            console.log(`  Final verdict  : ${results.finalVerdict}`);

            if (results.nodeReviews) {
                const passed = results.nodeReviews.filter((r: any) => r.verdict === "pass").length;
                const failed = results.nodeReviews.filter((r: any) => r.verdict === "fail").length;
                console.log(`  Nodes reviewed : ${results.nodeReviews.length}`);
                console.log(`    Passed       : ${passed}`);
                console.log(`    Failed       : ${failed}`);

                // Print details of failed nodes
                const failedReviews = results.nodeReviews.filter((r: any) => r.verdict === "fail");
                if (failedReviews.length > 0) {
                    console.log("\n  Failed nodes:");
                    for (const review of failedReviews) {
                        console.log(`    - ${review.nodeId}:`);
                        for (const issue of review.issues || []) {
                            console.log(`        [${issue.severity}] ${issue.description?.substring(0, 120) || "no description"}`);
                        }
                    }
                }
            }

            if (results.buildErrorHistory?.length > 0) {
                console.log(`\n  Build error episodes: ${results.buildErrorHistory.length}`);
                for (const ep of results.buildErrorHistory) {
                    console.log(`    - iter ${ep.iteration} (${ep.source}): ${ep.errors?.substring(0, 200) || "no details"}...`);
                }
            }

            if (results.fixerHistory?.length > 0) {
                console.log(`\n  Fixer passes: ${results.fixerHistory.length}`);
                for (const fp of results.fixerHistory) {
                    console.log(`    - iter ${fp.iteration}: modified ${fp.filesModified?.length || 0} files`);
                }
            }

            if (results.viteBuildError) {
                console.log(`\n  Final vite build: FAILED`);
                console.log(`    ${results.viteBuildError.substring(0, 300)}...`);
            } else {
                console.log(`\n  Final vite build: PASSED`);
            }

            console.log("");
        } catch (e) {
            console.warn("Could not parse review_results.json:", e);
        }
    } else {
        console.log("No review_results.json found (review loop may have been skipped or failed).");
    }

    process.exit(exitCode);
}

main().catch(err => {
    console.error("Test script failed:", err);
    process.exit(1);
});
