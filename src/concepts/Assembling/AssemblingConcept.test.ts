import { assertEquals } from "jsr:@std/assert";
import { Binary } from "npm:mongodb";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import AssemblingConcept from "./AssemblingConcept.ts";

Deno.test("AssemblingConcept - deleteProject removes assembly artifacts", async () => {
  const [db, client] = await testDb();
  const assembling = new AssemblingConcept(db);
  const project = "project-assembling-delete" as ID;

  try {
    await assembling.assemblies.insertOne({
      _id: project,
      downloadUrl: "/api/downloads/project-assembling-delete.zip",
      zipData: new Binary(new Uint8Array([1, 2, 3])),
      status: "complete",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await assembling.deleteProject({ project });
    assertEquals(result.deleted, 1);

    const url = await assembling._getDownloadUrl({ project });
    assertEquals(url.downloadUrl, "");
  } finally {
    await client.close();
  }
});
