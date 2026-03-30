import { assertEquals, assertExists } from "jsr:@std/assert";
import { Binary } from "npm:mongodb";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import PreviewingConcept from "./PreviewingConcept.ts";
import {
  PreviewLaunchInput,
  PreviewLaunchOutput,
  PreviewProvider,
  PreviewTeardownInput,
} from "./providers/types.ts";

class FakePreviewProvider implements PreviewProvider {
  launches: PreviewLaunchInput[] = [];
  teardowns: PreviewTeardownInput[] = [];
  failNextLaunch = false;
  nextLaunchErrorMessage = "forced launch error";
  failNextTeardown = false;
  nextTeardownErrorMessage = "forced teardown error";

  async launch(input: PreviewLaunchInput): Promise<PreviewLaunchOutput> {
    this.launches.push(input);
    if (this.failNextLaunch) {
      this.failNextLaunch = false;
      throw new Error(this.nextLaunchErrorMessage);
    }

    return {
      backendAppId: `backend-${input.launchId}`,
      backendUrl: `https://preview.example.com/backend-${input.launchId}`,
      frontendAppId: `frontend-${input.launchId}`,
      frontendUrl: `https://preview.example.com/frontend-${input.launchId}`,
    };
  }

  async teardown(input: PreviewTeardownInput): Promise<void> {
    this.teardowns.push(input);
    if (this.failNextTeardown) {
      this.failNextTeardown = false;
      throw new Error(this.nextTeardownErrorMessage);
    }
  }
}

async function waitForStatus(
  concept: PreviewingConcept,
  project: ID,
  expected: string,
) {
  for (let i = 0; i < 80; i++) {
    const rows = await concept._getPreview({ project });
    const preview = rows[0]?.preview;
    if (preview?.status === expected) return preview;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const rows = await concept._getPreview({ project });
  throw new Error(
    `Timed out waiting for status=${expected}. got=${rows[0]?.preview?.status}`,
  );
}

Deno.test("PreviewingConcept launch/relaunch/reap/delete flow", async () => {
  const [db, client] = await testDb();
  const fakeProvider = new FakePreviewProvider();
  const concept = new PreviewingConcept(db, () => fakeProvider);
  const project = "preview-project-1" as ID;
  const owner = "preview-owner-1" as ID;

  const prevEnabled = Deno.env.get("PREVIEWS_ENABLED");
  const prevProvider = Deno.env.get("PREVIEW_PROVIDER");
  const prevMaxActive = Deno.env.get("PREVIEW_MAX_ACTIVE_PER_USER");
  const prevMongo = Deno.env.get("PREVIEW_MONGODB_URL");

  Deno.env.set("PREVIEWS_ENABLED", "true");
  Deno.env.set("PREVIEW_PROVIDER", "mock");
  Deno.env.set("PREVIEW_MAX_ACTIVE_PER_USER", "2");
  Deno.env.set("PREVIEW_MONGODB_URL", Deno.env.get("MONGODB_URL") || "");

  try {
    await db.collection("Assembling.assemblies").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([1, 2, 3])),
      createdAt: new Date(),
      updatedAt: new Date(),
      downloadUrl: "/api/downloads/mock-backend.zip",
    } as any);
    await db.collection("FrontendGenerating.jobs").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([4, 5, 6])),
      createdAt: new Date(),
      updatedAt: new Date(),
      logs: [],
      downloadUrl: "/api/downloads/mock-frontend.zip",
    } as any);

    const launchOne = await concept.launch({ project, owner });
    assertEquals("error" in launchOne, false);
    assertEquals((launchOne as any).status, "processing");

    const readyOne = await waitForStatus(concept, project, "ready");
    assertExists(readyOne.frontendUrl);
    assertExists(readyOne.backendUrl);
    const launchIdOne = readyOne.launchId;

    const launchTwo = await concept.launch({ project, owner });
    assertEquals("error" in launchTwo, false);
    const readyTwo = await waitForStatus(concept, project, "ready");
    assertEquals(fakeProvider.teardowns.length >= 1, true);
    assertEquals(readyTwo.launchId === launchIdOne, false);

    await concept.previews.updateOne(
      { _id: project },
      { $set: { expiresAt: new Date(Date.now() - 1_000), status: "ready" } },
    );
    const reaped = await concept.reapExpired();
    assertEquals(reaped.reaped, 1);
    const expired = await waitForStatus(concept, project, "expired");
    assertEquals(expired.status, "expired");

    const deleted = await concept.deleteProject({ project });
    assertEquals("error" in deleted, false);
    assertEquals((deleted as any).deleted, 1);
    const afterDelete = await concept._getPreview({ project });
    assertEquals(afterDelete.length, 0);
  } finally {
    if (prevEnabled === undefined) Deno.env.delete("PREVIEWS_ENABLED");
    else Deno.env.set("PREVIEWS_ENABLED", prevEnabled);

    if (prevProvider === undefined) Deno.env.delete("PREVIEW_PROVIDER");
    else Deno.env.set("PREVIEW_PROVIDER", prevProvider);

    if (prevMaxActive === undefined) {
      Deno.env.delete("PREVIEW_MAX_ACTIVE_PER_USER");
    } else Deno.env.set("PREVIEW_MAX_ACTIVE_PER_USER", prevMaxActive);

    if (prevMongo === undefined) Deno.env.delete("PREVIEW_MONGODB_URL");
    else Deno.env.set("PREVIEW_MONGODB_URL", prevMongo);

    await client.close();
  }
});

Deno.test("PreviewingConcept reports actionable hosted preview MongoDB timeout", async () => {
  const [db, client] = await testDb();
  const fakeProvider = new FakePreviewProvider();
  const concept = new PreviewingConcept(db, () => fakeProvider);
  const project = "preview-project-mongo-timeout" as ID;
  const owner = "preview-owner-timeout" as ID;

  const prevEnabled = Deno.env.get("PREVIEWS_ENABLED");
  const prevProvider = Deno.env.get("PREVIEW_PROVIDER");
  const prevMongo = Deno.env.get("PREVIEW_MONGODB_URL");

  Deno.env.set("PREVIEWS_ENABLED", "true");
  Deno.env.set("PREVIEW_PROVIDER", "freestyle");
  Deno.env.set(
    "PREVIEW_MONGODB_URL",
    "mongodb+srv://example.mongodb.net/?retryWrites=true&w=majority",
  );

  try {
    await db.collection("Assembling.assemblies").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([1, 2, 3])),
      createdAt: new Date(),
      updatedAt: new Date(),
      downloadUrl: "/api/downloads/mock-backend.zip",
    } as any);
    await db.collection("FrontendGenerating.jobs").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([4, 5, 6])),
      createdAt: new Date(),
      updatedAt: new Date(),
      logs: [],
      downloadUrl: "/api/downloads/mock-frontend.zip",
    } as any);

    fakeProvider.failNextLaunch = true;
    fakeProvider.nextLaunchErrorMessage =
      "backend startup failed: MongoDB connection failed: MongoServerSelectionError: Server selection timed out after 30000 ms";

    const launch = await concept.launch({ project, owner });
    assertEquals("error" in launch, false);

    const errored = await waitForStatus(concept, project, "error");
    assertEquals(
      errored.lastError?.includes(
        'Preview backend could not reach PREVIEW_MONGODB_URL host "example.mongodb.net"',
      ),
      true,
    );
  } finally {
    if (prevEnabled === undefined) Deno.env.delete("PREVIEWS_ENABLED");
    else Deno.env.set("PREVIEWS_ENABLED", prevEnabled);

    if (prevProvider === undefined) Deno.env.delete("PREVIEW_PROVIDER");
    else Deno.env.set("PREVIEW_PROVIDER", prevProvider);

    if (prevMongo === undefined) Deno.env.delete("PREVIEW_MONGODB_URL");
    else Deno.env.set("PREVIEW_MONGODB_URL", prevMongo);

    await client.close();
  }
});

Deno.test("PreviewingConcept surfaces teardown failure without marking preview stopped", async () => {
  const [db, client] = await testDb();
  const fakeProvider = new FakePreviewProvider();
  const concept = new PreviewingConcept(db, () => fakeProvider);
  const project = "preview-project-teardown-failure" as ID;
  const owner = "preview-owner-teardown-failure" as ID;

  const prevEnabled = Deno.env.get("PREVIEWS_ENABLED");
  const prevProvider = Deno.env.get("PREVIEW_PROVIDER");
  const prevMongo = Deno.env.get("PREVIEW_MONGODB_URL");

  Deno.env.set("PREVIEWS_ENABLED", "true");
  Deno.env.set("PREVIEW_PROVIDER", "mock");
  Deno.env.set("PREVIEW_MONGODB_URL", Deno.env.get("MONGODB_URL") || "");

  try {
    await db.collection("Assembling.assemblies").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([1, 2, 3])),
      createdAt: new Date(),
      updatedAt: new Date(),
      downloadUrl: "/api/downloads/mock-backend.zip",
    } as any);
    await db.collection("FrontendGenerating.jobs").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([4, 5, 6])),
      createdAt: new Date(),
      updatedAt: new Date(),
      logs: [],
      downloadUrl: "/api/downloads/mock-frontend.zip",
    } as any);

    const launch = await concept.launch({ project, owner });
    assertEquals("error" in launch, false);
    await waitForStatus(concept, project, "ready");

    fakeProvider.failNextTeardown = true;
    fakeProvider.nextTeardownErrorMessage = "provider teardown exploded";

    const result = await concept.teardown({ project });
    assertEquals("error" in result, true);

    const errored = await waitForStatus(concept, project, "error");
    assertEquals(
      errored.lastError,
      "Failed to teardown preview deployment: provider teardown exploded",
    );
  } finally {
    if (prevEnabled === undefined) Deno.env.delete("PREVIEWS_ENABLED");
    else Deno.env.set("PREVIEWS_ENABLED", prevEnabled);

    if (prevProvider === undefined) Deno.env.delete("PREVIEW_PROVIDER");
    else Deno.env.set("PREVIEW_PROVIDER", prevProvider);

    if (prevMongo === undefined) Deno.env.delete("PREVIEW_MONGODB_URL");
    else Deno.env.set("PREVIEW_MONGODB_URL", prevMongo);

    await client.close();
  }
});

Deno.test("PreviewingConcept rejects local preview MongoDB URLs for hosted providers", async () => {
  const [db, client] = await testDb();
  const fakeProvider = new FakePreviewProvider();
  const concept = new PreviewingConcept(db, () => fakeProvider);
  const project = "preview-project-local-mongo" as ID;
  const owner = "preview-owner-local" as ID;

  const prevEnabled = Deno.env.get("PREVIEWS_ENABLED");
  const prevProvider = Deno.env.get("PREVIEW_PROVIDER");
  const prevMongo = Deno.env.get("PREVIEW_MONGODB_URL");

  Deno.env.set("PREVIEWS_ENABLED", "true");
  Deno.env.set("PREVIEW_PROVIDER", "freestyle");
  Deno.env.set("PREVIEW_MONGODB_URL", "mongodb://127.0.0.1:27017");

  try {
    await db.collection("Assembling.assemblies").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([1, 2, 3])),
      createdAt: new Date(),
      updatedAt: new Date(),
      downloadUrl: "/api/downloads/mock-backend.zip",
    } as any);
    await db.collection("FrontendGenerating.jobs").insertOne({
      _id: project,
      status: "complete",
      zipData: new Binary(new Uint8Array([4, 5, 6])),
      createdAt: new Date(),
      updatedAt: new Date(),
      logs: [],
      downloadUrl: "/api/downloads/mock-frontend.zip",
    } as any);

    const launch = await concept.launch({ project, owner });
    assertEquals("error" in launch, false);

    const errored = await waitForStatus(concept, project, "error");
    assertEquals(
      errored.lastError,
      'PREVIEW_MONGODB_URL must be reachable from the hosted preview VM. Current MongoDB host "127.0.0.1" is local/private and cannot be reached from freestyle previews.',
    );
    assertEquals(fakeProvider.launches.length, 0);
  } finally {
    if (prevEnabled === undefined) Deno.env.delete("PREVIEWS_ENABLED");
    else Deno.env.set("PREVIEWS_ENABLED", prevEnabled);

    if (prevProvider === undefined) Deno.env.delete("PREVIEW_PROVIDER");
    else Deno.env.set("PREVIEW_PROVIDER", prevProvider);

    if (prevMongo === undefined) Deno.env.delete("PREVIEW_MONGODB_URL");
    else Deno.env.set("PREVIEW_MONGODB_URL", prevMongo);

    await client.close();
  }
});
