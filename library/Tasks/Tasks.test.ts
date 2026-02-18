import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import TasksConcept, { Assignee, Creator, Item } from "./TasksConcept.ts";

const alice = "user:alice" as Creator;
const bob = "user:bob" as Assignee;
const charlie = "user:charlie" as Assignee;
const dishX = "item:dishX" as Item;

Deno.test({
  name: "Tasks: Hierarchy (Project Management)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const tasks = new TasksConcept(db);
  try {
    // 1. Create a Project (top-level task)
    const projectRes = await tasks.createTask({
      creator: alice,
      assignee: alice,
      title: "New Website",
      description: "Launch by Q3",
      dueDate: new Date("2026-09-01")
    });
    if ("error" in projectRes) throw new Error();

    // 2. Create sub-tasks
    await tasks.createTask({
      creator: alice,
      assignee: bob,
      title: "Design Homepage",
      description: "",
      parent: projectRes.taskId
    });
    await tasks.createTask({
      creator: alice,
      assignee: bob,
      title: "Frontend Setup",
      description: "",
      parent: projectRes.taskId
    });

    // 3. Query Projects
    const projects = await tasks._getProjects();
    assertEquals(projects[0].projects.length, 1);
    assertEquals(projects[0].projects[0].title, "New Website");

    // 4. Query Subtasks
    const subtasks = await tasks._getSubtasks({ parent: projectRes.taskId });
    assertEquals(subtasks[0].tasks.length, 2);

    // 5. Verify On Hold status
    await tasks.updateStatus({ taskId: projectRes.taskId, status: "On Hold" });
    const q = await tasks._getTask({ taskId: projectRes.taskId });
    assertEquals(q[0].task?.status, "On Hold");

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Tasks: Collaborative workflow & Detailed queries",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const tasks = new TasksConcept(db);
  try {
    // 1. Create tasks with different owners/items
    await tasks.createTask({ creator: alice, assignee: bob, title: "T1", description: "", item: dishX });
    await tasks.createTask({ creator: alice, assignee: charlie, title: "T2", description: "" });
    await tasks.createTask({ creator: bob, assignee: charlie, title: "T3", description: "" });

    // 2. Query by Assignee
    const bobTasks = await tasks._getTasksByAssignee({ assignee: bob });
    assertEquals(bobTasks[0].tasks.length, 1);
    assertEquals(bobTasks[0].tasks[0].title, "T1");

    const charlieTasks = await tasks._getTasksByAssignee({ assignee: charlie });
    assertEquals(charlieTasks[0].tasks.length, 2);

    // 3. Query by Creator
    const aliceCreated = await tasks._getTasksByCreator({ creator: alice });
    assertEquals(aliceCreated[0].tasks.length, 2);

    // 4. Query by Item
    const itemTasks = await tasks._getTasksByItem({ item: dishX });
    assertEquals(itemTasks[0].tasks.length, 1);
    assertEquals(itemTasks[0].tasks[0].title, "T1");

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Tasks: Lifecycle and Field Updates",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const tasks = new TasksConcept(db);
  try {
    const res = await tasks.createTask({
      creator: alice,
      assignee: bob,
      title: "Original Title",
      description: "Original Desc"
    });
    if ("error" in res) throw new Error();

    // 1. Update Details
    await tasks.updateDetails({
      taskId: res.taskId,
      title: "New Title",
      description: "New Desc",
      dueDate: new Date("2026-10-01")
    });

    const task = (await tasks._getTask({ taskId: res.taskId }))[0].task;
    assertEquals(task?.title, "New Title");
    assertEquals(task?.description, "New Desc");
    assertEquals(task?.dueDate instanceof Date, true);

    // 2. Reassign
    await tasks.assign({ taskId: res.taskId, assignee: charlie });
    const task2 = (await tasks._getTask({ taskId: res.taskId }))[0].task;
    assertEquals(task2?.assignee, charlie);

    // 3. Delete
    await tasks.deleteTask({ taskId: res.taskId });
    const empty = await tasks._getTask({ taskId: res.taskId });
    assertEquals(empty[0].task, null);

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Tasks: Cascade delete subtasks on deleteTask",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const tasks = new TasksConcept(db);
  try {
    // Create parent
    const parentRes = await tasks.createTask({ creator: alice, assignee: alice, title: "Parent", description: "" });
    if ("error" in parentRes) throw new Error("createTask failed");

    // Create child under parent
    const childRes = await tasks.createTask({ creator: alice, assignee: bob, title: "Child", description: "", parent: parentRes.taskId });
    if ("error" in childRes) throw new Error("createTask failed");

    // Create grandchild under child
    const grandchildRes = await tasks.createTask({ creator: alice, assignee: bob, title: "Grandchild", description: "", parent: childRes.taskId });
    if ("error" in grandchildRes) throw new Error("createTask failed");

    // Delete parent — should cascade to child and grandchild
    const del = await tasks.deleteTask({ taskId: parentRes.taskId });
    assertEquals("ok" in del, true);

    // Parent is gone
    assertEquals((await tasks._getTask({ taskId: parentRes.taskId }))[0].task, null);
    // Child is gone
    assertEquals((await tasks._getTask({ taskId: childRes.taskId }))[0].task, null);
    // Grandchild is gone
    assertEquals((await tasks._getTask({ taskId: grandchildRes.taskId }))[0].task, null);

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Tasks: Cleanup deletions (deleteByCreator, deleteByAssignee, deleteByItem)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const tasks = new TasksConcept(db);
  try {
    await tasks.createTask({ creator: alice, assignee: bob, title: "A1", description: "", item: dishX });
    await tasks.createTask({ creator: alice, assignee: bob, title: "A2", description: "", item: dishX });
    await tasks.createTask({ creator: bob, assignee: charlie, title: "B1", description: "" });

    // deleteByItem
    await tasks.deleteByItem({ item: dishX });
    assertEquals((await tasks._getTasksByItem({ item: dishX }))[0].tasks.length, 0);

    // deleteByCreator — alice created A1 and A2 (already deleted), bob created B1
    await tasks.createTask({ creator: alice, assignee: bob, title: "A3", description: "" });
    await tasks.deleteByCreator({ creator: alice });
    assertEquals((await tasks._getTasksByCreator({ creator: alice }))[0].tasks.length, 0);

    // deleteByAssignee — charlie is assigned B1
    await tasks.deleteByAssignee({ assignee: charlie });
    assertEquals((await tasks._getTasksByAssignee({ assignee: charlie }))[0].tasks.length, 0);

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Tasks: Edge cases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const tasks = new TasksConcept(db);
  try {
    // 1. Invalid ID
    const noTask = await tasks._getTask({ taskId: "invalid-oid" });
    assertEquals(noTask[0].task, null);

    // 2. Empty Title
    const err = await tasks.createTask({ creator: alice, assignee: bob, title: "", description: "" });
    assertEquals("error" in err, true);

    // 3. Update non-existent task
    const err2 = await tasks.updateStatus({ taskId: "nonexistent-task-id", status: "Done" });
    assertEquals("error" in err2, true);

    // 4. Invalid Status
    const res = await tasks.createTask({ creator: alice, assignee: bob, title: "Valid", description: "" });
    if ("error" in res) throw new Error();
    // @ts-ignore
    const err3 = await tasks.updateStatus({ taskId: res.taskId, status: "GHOST_STATUS" });
    assertEquals("error" in err3, true);

  } finally {
    await client.close();
  }
  },
});
