
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import FrontendGeneratingConcept from "./FrontendGeneratingConcept.ts";
import { parse } from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { join, dirname, fromFileUrl } from "https://deno.land/std@0.208.0/path/mod.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));

async function main() {
    console.log("Setting up test database...");
    const [db, client] = await testDb();
    const concept = new FrontendGeneratingConcept(db);

    try {
        console.log("Reading sample files...");
        const planPath = join(__dirname, "sample_plan.json");
        const apiPath = join(__dirname, "sample_open_api.yaml");

        const planJson = await Deno.readTextFile(planPath);
        const plan = JSON.parse(planJson);

        const apiYaml = await Deno.readTextFile(apiPath);
        const apiDefinition = parse(apiYaml) as Record<string, unknown>;

        const projectId = "manual-test-project" as ID;

        console.log("Triggering generation for:", projectId);
        const result = await concept.generate({
            project: projectId,
            plan,
            apiDefinition
        });

        if ("error" in result) {
            console.error("Generation start failed:", result.error);
            process.exit(1);
        }

        console.log("Job started. Polling for completion...");

        // Poll for completion (timeout 300s)
        let completed = false;
        for (let i = 0; i < 300; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const jobs = await concept._getJob({ project: projectId });
            const job = jobs[0];

            if (job) {
                if (job.status === "complete") {
                    console.log("Generation COMPLETE!");
                    console.log("Artifact URL:", job.artifactUrl);

                    // Verify artifact data in DB
                    if (job.artifactData) {
                        // Handle potential MongoDB Binary wrapper or Deno KV wrapping
                        let distinctData = job.artifactData;
                        // @ts-ignore
                        if (distinctData.buffer && distinctData.buffer instanceof ArrayBuffer) {
                             // It's likely a view or Node Buffer/Binary
                             // @ts-ignore
                             distinctData = new Uint8Array(distinctData.buffer);
                        }

                        console.log(`Artifact Data Found in DB. Type: ${typeof job.artifactData}`);
                        if (job.artifactData && typeof job.artifactData === 'object') {
                            // Check if it's an object with numeric keys (pseudo-array)
                            const vals = Object.values(job.artifactData);
                            if (vals.length > 0 && typeof vals[0] === 'number') {
                                console.log("Detected object with numeric values, converting to Uint8Array");
                                // @ts-ignore
                                distinctData = new Uint8Array(vals);
                            } else if (job.artifactData.buffer) {
                                // @ts-ignore
                                distinctData = new Uint8Array(job.artifactData.buffer);
                            }
                        }

                        if (distinctData instanceof Uint8Array) {
                            console.log(`Writing ${distinctData.length} bytes...`);
                            await Deno.writeFile("manual-test-project-from-db.zip", distinctData);
                            console.log("Saved artifact from DB to manual-test-project-from-db.zip");
                        } else {
                            // @ts-ignore
                             console.log("Data structure:", Deno.inspect(job.artifactData));
                             console.warn("Could not determine how to write this data type.");
                        }

                    } else {
                         console.warn("WARNING: No artifactData found in DB job record!");
                    }

                    console.log("Logs:", job.logs);
                    completed = true;
                    break;
                } else if (job.status === "error") {
                    console.error("Generation FAILED!");
                    console.error("Logs:", job.logs);
                    break;
                } else {
                    // console.log("Status:", job.status);
                    Deno.stdout.write(new TextEncoder().encode("."));
                }
            }
        }

        if (!completed) {
            console.error("Timed out waiting for generation.");
        }

    } catch (err) {
        console.error("Unexpected error:", err);
    } finally {
        await client.close();
    }
}

if (import.meta.main) {
    main();
}
