import { assertEquals } from "jsr:@std/assert";
import { Binary } from "npm:mongodb";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import GitHubExportingConcept from "./GitHubExportingConcept.ts";

const mongoTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });

mongoTest("GitHubExporting creates, reads, updates, and deletes one export", async () => {
  const [db, client] = await testDb();
  const exporting = new GitHubExportingConcept(db);
  const user = "user-1" as ID;
  const project = "project-1" as ID;
  try {
    const createResult = await exporting.createExport({
      user,
      project,
      artifact: "backend",
      repoName: "demo-backend",
      visibility: "private",
      status: "processing",
    });
    assertEquals(createResult, { ok: true });

    const byProject = await exporting._listExportsByProject({ project });
    assertEquals(byProject.length, 1);
    assertEquals(byProject[0].job.repoName, "demo-backend");

    const byUser = await exporting._listExportsByUser({ user });
    assertEquals(byUser.length, 1);
    assertEquals(byUser[0].job.artifact, "backend");

    const updateResult = await exporting.updateExport({
      project,
      artifact: "backend",
      patch: {
        status: "complete",
        repoUrl: "https://github.com/octocat/demo-backend",
        repoOwner: "octocat",
        repoId: "12345",
        remoteExists: true,
      },
    });
    assertEquals(updateResult, { ok: true });

    const [single] = await exporting._getExport({
      project,
      artifact: "backend",
    });
    assertEquals(single.job.status, "complete");
    assertEquals(single.job.repoOwner, "octocat");
    assertEquals(single.job.remoteExists, true);

    const deleteResult = await exporting.deleteExport({
      project,
      artifact: "backend",
    });
    assertEquals(deleteResult, { deleted: 1 });
    assertEquals(
      await exporting._getExport({ project, artifact: "backend" }),
      [],
    );
  } finally {
    await client.close();
  }
});

mongoTest("GitHubExporting deletes all export records for a project", async () => {
  const [db, client] = await testDb();
  const exporting = new GitHubExportingConcept(db);
  const user = "user-2" as ID;
  const project = "project-2" as ID;
  try {
    await exporting.createExport({
      user,
      project,
      artifact: "backend",
      repoName: "demo-backend",
      visibility: "private",
      status: "processing",
    });
    await exporting.createExport({
      user,
      project,
      artifact: "frontend",
      repoName: "demo-frontend",
      visibility: "public",
      status: "processing",
    });

    const deleteResult = await exporting.deleteProject({ project });
    assertEquals(deleteResult, { deleted: 2 });
    assertEquals(await exporting._listExportsByProject({ project }), []);
  } finally {
    await client.close();
  }
});

mongoTest("GitHubExporting checkRemoteExport marks stale when repo is gone", async () => {
  const [db, client] = await testDb();
  const exporting = new GitHubExportingConcept(db);
  const user = "user-3" as ID;
  const project = "project-3" as ID;
  try {
    await exporting.createExport({
      user,
      project,
      artifact: "backend",
      repoName: "demo-backend",
      visibility: "private",
      status: "complete",
    });
    await exporting.updateExport({
      project,
      artifact: "backend",
      patch: {
        repoOwner: "octocat",
        repoUrl: "https://github.com/octocat/demo-backend",
        remoteExists: true,
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    try {
      const remoteCheck = await exporting.checkRemoteExport({
        project,
        artifact: "backend",
        accessToken: "ghu_access_123",
      });
      assertEquals(remoteCheck, { remoteExists: false });

      const [job] = await exporting._getExport({
        project,
        artifact: "backend",
      });
      assertEquals(job.job.status, "stale");
      assertEquals(job.job.remoteExists, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await client.close();
  }
});

mongoTest("GitHubExporting startExport rejects missing build artifact", async () => {
  const [db, client] = await testDb();
  const exporting = new GitHubExportingConcept(db);
  const user = "user-4" as ID;
  const project = "project-4" as ID;
  try {
    const startResult = await exporting.startExport({
      user,
      project,
      artifact: "frontend",
      repoName: "demo-frontend",
      visibility: "private",
      accessToken: "ghu_access_123",
    });
    assertEquals(startResult, {
      error: "Requested build artifact is not available for export.",
      statusCode: 404,
    });
  } finally {
    await client.close();
  }
});

mongoTest("GitHubExporting startExport blocks duplicate export while remote exists", async () => {
  const [db, client] = await testDb();
  const exporting = new GitHubExportingConcept(db);
  const user = "user-5" as ID;
  const project = "project-5" as ID;
  try {
    await (db.collection("Assembling.assemblies") as any).insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([1, 2, 3])),
    });
    await exporting.createExport({
      user,
      project,
      artifact: "backend",
      repoName: "demo-backend",
      visibility: "private",
      status: "complete",
    });
    await exporting.updateExport({
      project,
      artifact: "backend",
      patch: {
        repoOwner: "octocat",
        repoUrl: "https://github.com/octocat/demo-backend",
        remoteExists: true,
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 123 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    try {
      const startResult = await exporting.startExport({
        user,
        project,
        artifact: "backend",
        repoName: "demo-backend",
        visibility: "private",
        accessToken: "ghu_access_123",
      });
      assertEquals(startResult, {
        error: "This artifact is already exported to a live GitHub repository.",
        statusCode: 409,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await client.close();
  }
});
