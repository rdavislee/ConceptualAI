import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import ConnectingConcept, { Requester, Responder } from "./ConnectingConcept.ts";

const userA = "user:A" as Requester;
const userB = "user:B" as Responder;
const userC = "user:C" as Responder;

const mongoTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn });

mongoTest("Connecting: Basic request/accept lifecycle", async () => {
  const [db, client] = await testDb();
  const connecting = new ConnectingConcept(db);
  try {
    // 1. A requests B
    await connecting.requestConnection({ requester: userA, responder: userB });

    // 2. Verify pending
    const pending = await connecting._getPendingRequests({ responder: userB });
    assertEquals(pending[0].requesters.length, 1);
    assertEquals(pending[0].requesters[0], userA);

    const isConnected1 = await connecting._isConnected({ partyA: userA, partyB: userB });
    assertEquals(isConnected1[0].connected, false);

    // 3. B accepts A
    await connecting.acceptConnection({ responder: userB, requester: userA });

    // 4. Verify connected
    const isConnected2 = await connecting._isConnected({ partyA: userA, partyB: userB });
    assertEquals(isConnected2[0].connected, true);

    const connectionsA = await connecting._getConnections({ user: userA });
    assertEquals(connectionsA[0].users.includes(userB), true);

    const connectionsB = await connecting._getConnections({ user: userB });
    assertEquals(connectionsB[0].users.includes(userA as string), true);

  } finally {
    await client.close();
  }
});

mongoTest("Connecting: Reject and Remove lifecycle", async () => {
  const [db, client] = await testDb();
  const connecting = new ConnectingConcept(db);
  try {
    // A requests C
    await connecting.requestConnection({ requester: userA, responder: userC });

    // C rejects A
    await connecting.rejectConnection({ responder: userC, requester: userA });
    const pending = await connecting._getPendingRequests({ responder: userC });
    assertEquals(pending[0].requesters.length, 0);

    // B requests C (and gets accepted)
    const userB_Req = userB as unknown as Requester;
    await connecting.requestConnection({ requester: userB_Req, responder: userC });
    await connecting.acceptConnection({ responder: userC, requester: userB_Req });

    // Remove connection
    await connecting.removeConnection({ partyA: userB_Req, partyB: userC });
    const isConnected = await connecting._isConnected({ partyA: userB_Req, partyB: userC });
    assertEquals(isConnected[0].connected, false);

    // deleteByRequester and deleteByResponder
    await connecting.requestConnection({ requester: userA, responder: userB });
    await connecting.deleteByRequester({ requester: userA });
    const pendingB = await connecting._getPendingRequests({ responder: userB });
    assertEquals(pendingB[0].requesters.includes(userA), false);

    await connecting.requestConnection({ requester: userA, responder: userC });
    await connecting.deleteByResponder({ responder: userC });
    const pendingC = await connecting._getPendingRequests({ responder: userC });
    assertEquals(pendingC[0].requesters.length, 0);

  } finally {
    await client.close();
  }
});
