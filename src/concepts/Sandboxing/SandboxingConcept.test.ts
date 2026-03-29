import "jsr:@std/dotenv/load";
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import SandboxingConcept from "./SandboxingConcept.ts";

const sandboxA = "sandbox:A" as ID;
const sandboxB = "sandbox:B" as ID;
const userA = "user:A" as ID;
const projectA = "project:A" as ID;
const projectB = "project:B" as ID;

Deno.test("Action: touch refreshes sandbox lastActiveAt", async () => {
  const [db, client] = await testDb();
  const sandboxing = new SandboxingConcept(db);
  const oldTimestamp = new Date(Date.now() - 60_000);

  try {
    await sandboxing.sandboxes.insertOne({
      _id: sandboxA,
      userId: userA,
      projectId: projectA,
      containerId: "container-a",
      endpoint: "ephemeral",
      status: "ready",
      createdAt: oldTimestamp,
      lastActiveAt: oldTimestamp,
    } as any);

    const result = await sandboxing.touch({ sandboxId: sandboxA });
    assertEquals("error" in result, false);

    const sandbox = await sandboxing.sandboxes.findOne({ _id: sandboxA });
    assertExists(sandbox);
    assertEquals(sandbox.lastActiveAt.getTime() > oldTimestamp.getTime(), true);
  } finally {
    await client.close();
  }
});

Deno.test("Action: reap skips recently touched sandbox and reaps stale one", async () => {
  const [db, client] = await testDb();
  const sandboxing = new SandboxingConcept(db);
  const staleTimestamp = new Date(Date.now() - 31 * 60 * 1000);
  const ancientTimestamp = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const reaped: ID[] = [];

  try {
    await sandboxing.sandboxes.insertOne({
      _id: sandboxA,
      userId: userA,
      projectId: projectA,
      containerId: "container-a",
      endpoint: "ephemeral",
      status: "ready",
      createdAt: staleTimestamp,
      lastActiveAt: staleTimestamp,
    } as any);
    await sandboxing.sandboxes.insertOne({
      _id: sandboxB,
      userId: userA,
      projectId: projectB,
      containerId: "container-b",
      endpoint: "ephemeral",
      status: "ready",
      createdAt: ancientTimestamp,
      lastActiveAt: ancientTimestamp,
    } as any);

    await sandboxing.touch({ sandboxId: sandboxB });

    (sandboxing as any).teardown = async ({ sandboxId }: { sandboxId: ID }) => {
      reaped.push(sandboxId);
      await sandboxing.sandboxes.updateOne(
        { _id: sandboxId },
        { $set: { status: "terminated", lastActiveAt: new Date() } },
      );
      return {};
    };

    const result = await sandboxing.reap();
    assertEquals(result.reaped, 1);
    assertEquals(reaped, [sandboxA]);

    const staleSandbox = await sandboxing.sandboxes.findOne({ _id: sandboxA });
    const touchedSandbox = await sandboxing.sandboxes.findOne({ _id: sandboxB });
    assertEquals(staleSandbox?.status, "terminated");
    assertEquals(touchedSandbox?.status, "ready");
  } finally {
    await client.close();
  }
});

Deno.test("Action: reap expires stale provisioning sandbox by heartbeat age", async () => {
  const [db, client] = await testDb();
  const sandboxing = new SandboxingConcept(db);
  const staleTimestamp = new Date(Date.now() - 121 * 60 * 1000);
  const reaped: ID[] = [];

  try {
    await sandboxing.sandboxes.insertOne({
      _id: sandboxA,
      userId: userA,
      projectId: projectA,
      containerId: "container-a",
      endpoint: "ephemeral",
      status: "provisioning",
      createdAt: staleTimestamp,
      lastActiveAt: staleTimestamp,
    } as any);

    (sandboxing as any).teardown = async ({ sandboxId }: { sandboxId: ID }) => {
      reaped.push(sandboxId);
      await sandboxing.sandboxes.updateOne(
        { _id: sandboxId },
        { $set: { status: "terminated", lastActiveAt: new Date() } },
      );
      return {};
    };

    const result = await sandboxing.reap();
    assertEquals(result.reaped, 1);
    assertEquals(reaped, [sandboxA]);

    const staleSandbox = await sandboxing.sandboxes.findOne({ _id: sandboxA });
    assertEquals(staleSandbox?.status, "terminated");
  } finally {
    await client.close();
  }
});
