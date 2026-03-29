import { assertEquals, assertExists } from "jsr:@std/assert";
import { Binary } from "npm:mongodb";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

type StageFixture = {
  status: string;
  expectedStatus: string;
  needsDesign?: boolean;
  needsImpl?: boolean;
  needsSync?: boolean;
  needsAssembly?: boolean;
  needsFrontend?: boolean;
  withSandbox?: boolean;
};

Deno.test({
  name: "Sync: Revert project endpoint across lifecycle stages",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const [db, client] = await testDb();

    const ProjectLedger = concepts.ProjectLedger as any;
    const Requesting = concepts.Requesting as any;
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Sandboxing = concepts.Sandboxing as any;
    const ConceptDesigning = concepts.ConceptDesigning as any;
    const Implementing = concepts.Implementing as any;
    const SyncGenerating = concepts.SyncGenerating as any;
    const Assembling = concepts.Assembling as any;
    const FrontendGenerating = concepts.FrontendGenerating as any;

    ProjectLedger.projects = db.collection("ProjectLedger.projects");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Sandboxing.sandboxes = db.collection("Sandboxing.sandboxes");
    ConceptDesigning.designs = db.collection("ConceptDesigning.designs");
    Implementing.implJobs = db.collection("Implementing.implJobs");
    SyncGenerating.syncJobs = db.collection("SyncGenerating.syncJobs");
    Assembling.assemblies = db.collection("Assembling.assemblies");
    FrontendGenerating.jobs = db.collection("FrontendGenerating.jobs");

    const createProject = async (
      projectId: string,
      owner: string,
      fixture: StageFixture,
    ) => {
      await ProjectLedger.projects.insertOne({
        _id: projectId,
        owner,
        name: `Project-${projectId}`,
        description: "revert test fixture",
        status: fixture.status,
        autocomplete: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      if (fixture.needsDesign) {
        await ConceptDesigning.designs.insertOne({
          _id: projectId,
          plan: {},
          libraryPulls: [],
          customConcepts: [],
          status: "complete",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      if (fixture.needsImpl) {
        await Implementing.implJobs.insertOne({
          _id: projectId,
          design: {},
          implementations: {},
          status: "complete",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      if (fixture.needsSync) {
        await SyncGenerating.syncJobs.insertOne({
          _id: projectId,
          syncs: [],
          apiDefinition: {
            format: "openapi",
            encoding: "yaml",
            content: "openapi: 3.0.0\ninfo:\n  title: x\n  version: 1.0.0",
          },
          endpointBundles: [],
          status: "complete",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      if (fixture.needsAssembly) {
        await Assembling.assemblies.insertOne({
          _id: projectId,
          downloadUrl: `/api/downloads/${projectId}.zip`,
          zipData: new Binary(new Uint8Array([1, 2, 3])),
          status: "complete",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      if (fixture.needsFrontend) {
        await FrontendGenerating.jobs.insertOne({
          _id: projectId,
          status: "complete",
          downloadUrl: `/api/downloads/${projectId}_frontend.zip`,
          logs: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      if (fixture.withSandbox) {
        await Sandboxing.sandboxes.insertOne({
          _id: `sb-${projectId}`,
          userId: owner,
          projectId,
          containerId: `sandbox-sb-${projectId}`,
          endpoint: "ephemeral",
          status: "ready",
          createdAt: new Date(),
          lastActiveAt: new Date(),
        });
      }
    };

    const triggerRevert = async (projectId: string, accessToken: string) => {
      const { request } = await Requesting.request({
        path: `/projects/${projectId}/revert`,
        method: "POST",
        accessToken,
      });
      const [response] = await Requesting._awaitResponse({ request });
      return response.response as any;
    };

    try {
      Engine.logging = Logging.VERBOSE;
      Engine.register(syncs);

      const { user } = await Authenticating.register({
        email: "revert-flow@test.com",
        password: "pw",
      });
      const { accessToken } = await Sessioning.create({ user });

      const scenarios: Array<{ id: string; fixture: StageFixture }> = [
        {
          id: "designing-project",
          fixture: {
            status: "designing",
            expectedStatus: "planning_complete",
            needsDesign: true,
            withSandbox: true,
          },
        },
        {
          id: "design-complete-project",
          fixture: {
            status: "design_complete",
            expectedStatus: "planning_complete",
            needsDesign: true,
          },
        },
        {
          id: "implementing-project",
          fixture: {
            status: "implementing",
            expectedStatus: "design_complete",
            needsImpl: true,
            withSandbox: true,
          },
        },
        {
          id: "implemented-project",
          fixture: {
            status: "implemented",
            expectedStatus: "design_complete",
            needsImpl: true,
          },
        },
        {
          id: "sync-generating-project",
          fixture: {
            status: "sync_generating",
            expectedStatus: "implemented",
            needsSync: true,
            withSandbox: true,
          },
        },
        {
          id: "syncs-generated-project",
          fixture: {
            status: "syncs_generated",
            expectedStatus: "implemented",
            needsSync: true,
          },
        },
        {
          id: "assembling-project",
          fixture: {
            status: "assembling",
            expectedStatus: "syncs_generated",
            needsAssembly: true,
            needsFrontend: true,
            withSandbox: true,
          },
        },
        {
          id: "building-project",
          fixture: {
            status: "building",
            expectedStatus: "syncs_generated",
            needsAssembly: true,
            needsFrontend: true,
            withSandbox: true,
          },
        },
        {
          id: "assembled-project",
          fixture: {
            status: "assembled",
            expectedStatus: "syncs_generated",
            needsAssembly: true,
            needsFrontend: true,
          },
        },
        {
          id: "complete-project",
          fixture: {
            status: "complete",
            expectedStatus: "syncs_generated",
            needsAssembly: true,
            needsFrontend: true,
          },
        },
      ];

      for (const scenario of scenarios) {
        await t.step(`reverts ${scenario.fixture.status}`, async () => {
          await createProject(scenario.id, user, scenario.fixture);

          const response = await triggerRevert(scenario.id, accessToken);
          assertEquals(response.project, scenario.id);
          assertEquals(response.status, scenario.fixture.expectedStatus);
          assertExists(response.revertedFrom);

          const projectAfter = await ProjectLedger.projects.findOne({ _id: scenario.id });
          assertExists(projectAfter);
          assertEquals(projectAfter.status, scenario.fixture.expectedStatus);

          if (scenario.fixture.needsDesign) {
            const designAfter = await ConceptDesigning.designs.findOne({ _id: scenario.id });
            assertEquals(designAfter, null);
          }
          if (scenario.fixture.needsImpl) {
            const implAfter = await Implementing.implJobs.findOne({ _id: scenario.id });
            assertEquals(implAfter, null);
          }
          if (scenario.fixture.needsSync) {
            const syncAfter = await SyncGenerating.syncJobs.findOne({ _id: scenario.id });
            assertEquals(syncAfter, null);
          }
          if (scenario.fixture.needsAssembly) {
            const assemblyAfter = await Assembling.assemblies.findOne({ _id: scenario.id });
            assertEquals(assemblyAfter, null);
          }
          if (scenario.fixture.needsFrontend) {
            const frontendAfter = await FrontendGenerating.jobs.findOne({ _id: scenario.id });
            assertEquals(frontendAfter, null);
          }
          if (scenario.fixture.withSandbox) {
            const sandboxAfter = await Sandboxing.sandboxes.findOne({ _id: `sb-${scenario.id}` });
            assertExists(sandboxAfter);
            assertEquals(sandboxAfter.status, "terminated");
          }
        });
      }

      await t.step("blocks revert for first-stage projects", async () => {
        const blockedId = "planning-blocked";
        await createProject(blockedId, user, {
          status: "planning",
          expectedStatus: "planning",
        });

        const response = await triggerRevert(blockedId, accessToken);
        assertEquals(response.statusCode, 409);
      });
    } finally {
      await client.close();
    }
  },
});
