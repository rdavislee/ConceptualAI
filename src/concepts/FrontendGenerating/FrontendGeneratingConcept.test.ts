import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import FrontendGeneratingConcept, { type FrontendJob } from "./FrontendGeneratingConcept.ts";

Deno.test("FrontendGeneratingConcept", async (t) => {
  const [db, client] = await testDb();
  const concept = new FrontendGeneratingConcept(db);

  await t.step("generate starts a job", async () => {
    const result = await concept.generate({
      project: "proj-1" as ID,
      plan: { name: "Test App" },
      apiDefinition: { openapi: "3.0.0" },
    });

    assert(!("error" in result));
    assertEquals(result.status, "processing");

    const jobs = await concept._getJob({ project: "proj-1" as ID });
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].status, "processing");
  });

  await t.step("generate fails if job already processing", async () => {
    const result = await concept.generate({
      project: "proj-1" as ID,
      plan: { name: "Test App" },
      apiDefinition: { openapi: "3.0.0" },
    });

    assert("error" in result);
    assertEquals(result.error, "Job already in progress for project");
  });

  await t.step("background process completes (simulated)", async () => {
    // Wait for background task (poll for up to 120s)
    let jobs: FrontendJob[] = [];
    for (let i = 0; i < 240; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        jobs = await concept._getJob({ project: "proj-1" as ID });
        if (jobs.length > 0 && (jobs[0].status === "complete" || jobs[0].status === "error")) break;
    }

    assertEquals(jobs[0]?.status, "complete", `Job failed or timed out. Logs: ${JSON.stringify(jobs[0]?.logs)}`);
    assert(jobs[0].downloadUrl?.includes("/api/downloads/proj-1_frontend.zip"));

    // Verify retrieval methods
    const downloadInfo = await concept._getDownloadUrl({ project: "proj-1" as ID });
    assertEquals(downloadInfo.downloadUrl, jobs[0].downloadUrl);

    const fileStream = await concept.getFileStream({ project: "proj-1" as ID });
    assert(fileStream !== null, "File stream should not be null");

    // Read stream to verify content
    const reader = fileStream.getReader();
    const { value, done } = await reader.read();
    assert(!done, "Stream should have data");
    assert(value && value.length > 0, "Stream data should not be empty");
    reader.releaseLock();
  });

  await client.close();
});
