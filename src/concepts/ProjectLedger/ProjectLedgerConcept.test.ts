import "jsr:@std/dotenv/load";
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ProjectLedgerConcept, { ProjectDoc } from "./ProjectLedgerConcept.ts";

const userA = "user:Alice" as ID;
const userB = "user:Bob" as ID;
const project1 = "project:1" as ID;
const project2 = "project:2" as ID;

Deno.test("Principle: ProjectLedger basic flow", async () => {
  const [db, client] = await testDb();
  const ledger = new ProjectLedgerConcept(db);

  try {
    // 1. Create a project
    const createResult = await ledger.create({
      owner: userA,
      project: project1,
      name: "My App",
      description: "A cool app",
    });

    assertEquals("error" in createResult, false);
    if ("project" in createResult) {
      assertEquals(createResult.project, project1);
    }

    // 2. Verify project exists and has correct initial state
    const projectQuery = await ledger._getProject({ project: project1 });
    assertEquals(projectQuery.length, 1);
    const res = projectQuery[0];
    if ("error" in res) throw new Error(res.error);
    const p = res.project;
    assertEquals(p.owner, userA);
    assertEquals(p.name, "My App");
    assertEquals(p.status, "planning");
    assertEquals(p.autocomplete, false);
    assertExists(p.createdAt);
    assertExists(p.updatedAt);

    // 3. Verify owner query
    const ownerQuery = await ledger._getOwner({ project: project1 });
    assertEquals(ownerQuery.length, 1);
    assertEquals(ownerQuery[0].owner, userA);

    // 4. Update status
    const updateResult = await ledger.updateStatus({
      project: project1,
      status: "designing",
    });
    assertEquals("error" in updateResult, false);

    // 5. Verify status update
    const updatedProjectQuery = await ledger._getProject({ project: project1 });
    const updatedRes = updatedProjectQuery[0];
    if ("error" in updatedRes) throw new Error(updatedRes.error);
    assertEquals(updatedRes.project.status, "designing");
    
    // Check updatedAt changed (might be same second, but should be >=)
    const newUpdatedAt = updatedRes.project.updatedAt;
    assertEquals(newUpdatedAt.getTime() >= p.updatedAt.getTime(), true);

  } finally {
    await client.close();
  }
});

Deno.test("Action: create requires unique project ID", async () => {
  const [db, client] = await testDb();
  const ledger = new ProjectLedgerConcept(db);

  try {
    await ledger.create({
      owner: userA,
      project: project1,
      name: "App 1",
      description: "Desc 1",
    });

    const duplicateResult = await ledger.create({
      owner: userB, // Different owner
      project: project1, // Same project ID
      name: "App 2",
      description: "Desc 2",
    });

    assertEquals("error" in duplicateResult, true);
    if ("error" in duplicateResult) {
      assertEquals(duplicateResult.error, "Project already exists");
    }
  } finally {
    await client.close();
  }
});

Deno.test("Query: _getProjects returns all projects for owner", async () => {
  const [db, client] = await testDb();
  const ledger = new ProjectLedgerConcept(db);

  try {
    // Create two projects for userA
    await ledger.create({
      owner: userA,
      project: project1,
      name: "App 1",
      description: "Desc 1",
    });
    await ledger.create({
      owner: userA,
      project: project2,
      name: "App 2",
      description: "Desc 2",
    });

    // Create one project for userB
    await ledger.create({
      owner: userB,
      project: "project:3" as ID,
      name: "App 3",
      description: "Desc 3",
    });

    // Query for userA
    const projectsA = await ledger._getProjects({ owner: userA });
    assertEquals(projectsA.length, 1);
    const listA = projectsA[0].projects;
    assertEquals(listA.length, 2);
    // Sort by ID to ensure consistent order for checking? Or just check contents
    const ids = listA.map(r => r._id).sort();
    assertEquals(ids, [project1, project2].sort());

    // Query for userB
    const projectsB = await ledger._getProjects({ owner: userB });
    assertEquals(projectsB.length, 1);
    assertEquals(projectsB[0].projects[0]._id, "project:3");

    // Query for user with no projects
    const projectsC = await ledger._getProjects({ owner: "user:C" as ID });
    assertEquals(projectsC.length, 1);
    assertEquals(projectsC[0].projects.length, 0);

  } finally {
    await client.close();
  }
});

Deno.test("Action: updateStatus requires existing project", async () => {
  const [db, client] = await testDb();
  const ledger = new ProjectLedgerConcept(db);

  try {
    const result = await ledger.updateStatus({
      project: "nonexistent:project" as ID,
      status: "designing",
    });
    
    assertEquals("error" in result, true);
    if ("error" in result) {
      assertEquals(result.error, "Project does not exist");
    }
  } finally {
    await client.close();
  }
});

Deno.test("Action: updateAutocomplete toggles project autocomplete", async () => {
  const [db, client] = await testDb();
  const ledger = new ProjectLedgerConcept(db);

  try {
    await ledger.create({
      owner: userA,
      project: project1,
      name: "Autocomplete App",
      description: "Autocomplete test",
    });

    const enabledResult = await ledger.updateAutocomplete({
      project: project1,
      autocomplete: true,
    });
    assertEquals("error" in enabledResult, false);

    const enabledQuery = await ledger._getProject({ project: project1 });
    if ("error" in enabledQuery[0]) throw new Error(enabledQuery[0].error);
    assertEquals(enabledQuery[0].project.autocomplete, true);

    const disabledResult = await ledger.updateAutocomplete({
      project: project1,
      autocomplete: false,
    });
    assertEquals("error" in disabledResult, false);

    const disabledQuery = await ledger._getProject({ project: project1 });
    if ("error" in disabledQuery[0]) throw new Error(disabledQuery[0].error);
    assertEquals(disabledQuery[0].project.autocomplete, false);
  } finally {
    await client.close();
  }
});

Deno.test("Query: legacy project rows default autocomplete to false", async () => {
  const [db, client] = await testDb();
  const ledger = new ProjectLedgerConcept(db);

  try {
    await ledger.projects.insertOne({
      _id: project1,
      owner: userA,
      name: "Legacy App",
      description: "Before autocomplete existed",
      status: "planning",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const projectQuery = await ledger._getProject({ project: project1 });
    if ("error" in projectQuery[0]) throw new Error(projectQuery[0].error);
    assertEquals(projectQuery[0].project.autocomplete, false);

    const projectsQuery = await ledger._getProjects({ owner: userA });
    assertEquals(projectsQuery[0].projects.length, 1);
    assertEquals(projectsQuery[0].projects[0].autocomplete, false);
  } finally {
    await client.close();
  }
});

Deno.test("Action: delete removes project", async () => {
  const [db, client] = await testDb();
  const ledger = new ProjectLedgerConcept(db);

  try {
    // 1. Create a project
    await ledger.create({
      owner: userA,
      project: project1,
      name: "App 1",
      description: "Desc 1",
    });

    // Verify it exists
    const query1 = await ledger._getProject({ project: project1 });
    assertEquals(query1.length, 1);
    if ("error" in query1[0]) throw new Error(query1[0].error);

    // 2. Delete it
    const deleteResult = await ledger.delete({ project: project1 });
    assertEquals("error" in deleteResult, false);

    // 3. Verify it is gone
    const query2 = await ledger._getProject({ project: project1 });
    assertEquals(query2.length, 1);
    assertEquals("error" in query2[0], true);
    if ("error" in query2[0]) {
      assertEquals(query2[0].error, "Project not found");
    }

    // 4. Try deleting again (should fail)
    const deleteResult2 = await ledger.delete({ project: project1 });
    assertEquals("error" in deleteResult2, true);
    if ("error" in deleteResult2) {
      assertEquals(deleteResult2.error, "Project does not exist");
    }

  } finally {
    await client.close();
  }
});
