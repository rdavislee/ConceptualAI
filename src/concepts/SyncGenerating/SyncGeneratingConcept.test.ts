import "jsr:@std/dotenv/load";
import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import SyncGeneratingConcept, {
  ApiDefinition,
  EndpointBundle,
  SyncDefinition,
} from "./SyncGeneratingConcept.ts";

const project1 = "project:1" as ID;

Deno.test("Query: _getSyncs returns syncs and api definition", async () => {
  const [db, client] = await testDb();
  const syncGenerating = new SyncGeneratingConcept(db);

  try {
    const syncs: SyncDefinition[] = [
      {
        name: "ExampleSync",
        when: {
          "Requesting.request": { path: "/example" },
        },
        then: [["Requesting.respond", { status: "ok" }]],
      },
    ];
    const apiDefinition: ApiDefinition = {
      format: "openapi",
      encoding: "yaml",
      content: "openapi: 3.0.0\ninfo:\n  title: Example\n  version: 0.0.1",
    };
    const endpointBundles: EndpointBundle[] = [{
      endpoint: { method: "POST", path: "/example" },
      syncs,
      testFile: "Deno.test('example', () => {});",
    }];

    await syncGenerating.syncJobs.insertOne({
      _id: project1,
      syncs,
      apiDefinition,
      endpointBundles,
      status: "complete",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await syncGenerating._getSyncs({ project: project1 });
    assertEquals(result.length, 1);
    assertEquals(result[0].syncs[0].name, "ExampleSync");
    assertEquals(result[0].apiDefinition.format, "openapi");
  } finally {
    await client.close();
  }
});
