import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import EventsConcept, { Owner } from "./EventsConcept.ts";

const user1 = "user:alice" as Owner;
const user2 = "user:bob" as Owner;

Deno.test({
  name: "Events: Comprehensive overlap tests",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const events = new EventsConcept(db);
    try {
    // 1. Create base event: 10am - 12pm
    await events.createEvent({
      owner: user1,
      title: "Core Event",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: new Date("2026-01-01T12:00:00Z"),
      description: ""
    });

    // 2. Query exactly same range
    const q1 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T10:00:00Z"),
      to: new Date("2026-01-01T12:00:00Z")
    });
    assertEquals(q1[0].events.length, 1);

    // 3. Query overlapping before (9am - 11am)
    const q2 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T09:00:00Z"),
      to: new Date("2026-01-01T11:00:00Z")
    });
    assertEquals(q2[0].events.length, 1);

    // 4. Query overlapping after (11am - 1pm)
    const q3 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T11:00:00Z"),
      to: new Date("2026-01-01T13:00:00Z")
    });
    assertEquals(q3[0].events.length, 1);

    // 5. Query completely contained (10:30am - 11:30am)
    const q4 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T10:30:00Z"),
      to: new Date("2026-01-01T11:30:00Z")
    });
    assertEquals(q4[0].events.length, 1);

    // 6. Query completely containing (9am - 1pm)
    const q5 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T09:00:00Z"),
      to: new Date("2026-01-01T13:00:00Z")
    });
    assertEquals(q5[0].events.length, 1);

    // 7. Query adjacent before (9am - 10am) - should NOT overlap
    const q6 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T09:00:00Z"),
      to: new Date("2026-01-01T10:00:00Z")
    });
    assertEquals(q6[0].events.length, 0);

    // 8. Query adjacent after (12pm - 1pm) - should NOT overlap
    const q7 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T12:00:00Z"),
      to: new Date("2026-01-01T13:00:00Z")
    });
    assertEquals(q7[0].events.length, 0);

    } finally {
      await client.close();
    }
  },
});

Deno.test("Events: Basic CRUD operations", async () => {
  const [db, client] = await testDb();
  const events = new EventsConcept(db);
  try {
    // Create
    const res = await events.createEvent({
      owner: user1,
      title: "Test Event",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: new Date("2026-01-01T11:00:00Z"),
      description: "Original description"
    });
    if ("error" in res) throw new Error();

    // Update
    await events.updateEvent({
      eventId: res.eventId,
      title: "Updated Title",
      description: "Updated description"
    });

    const q = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-02T00:00:00Z")
    });
    assertEquals(q[0].events[0].title, "Updated Title");
    assertEquals(q[0].events[0].description, "Updated description");

    // Delete
    await events.deleteEvent({ eventId: res.eventId });
    const qAfter = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-02T00:00:00Z")
    });
    assertEquals(qAfter[0].events.length, 0);

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Events: Edge cases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const events = new EventsConcept(db);
    try {
      // Invalid time range
      const err = await events.createEvent({
        owner: user1,
        title: "Bad Event",
        startTime: new Date("2026-01-01T11:00:00Z"),
        endTime: new Date("2026-01-01T10:00:00Z"),
        description: "",
      });
      assertEquals("error" in err, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test("Events: deleteByOwner removes all events for owner", async () => {
  const [db, client] = await testDb();
  const events = new EventsConcept(db);
  try {
    await events.createEvent({
      owner: user1,
      title: "E1",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: new Date("2026-01-01T11:00:00Z"),
      description: ""
    });
    await events.createEvent({
      owner: user1,
      title: "E2",
      startTime: new Date("2026-01-01T14:00:00Z"),
      endTime: new Date("2026-01-01T15:00:00Z"),
      description: ""
    });
    await events.createEvent({
      owner: user2,
      title: "E3",
      startTime: new Date("2026-01-01T16:00:00Z"),
      endTime: new Date("2026-01-01T17:00:00Z"),
      description: ""
    });

    await events.deleteByOwner({ owner: user1 });

    const q1 = await events._getEvents({
      owner: user1,
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-02T00:00:00Z")
    });
    const q2 = await events._getEvents({
      owner: user2,
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-02T00:00:00Z")
    });
    assertEquals(q1[0].events.length, 0);
    assertEquals(q2[0].events.length, 1);
  } finally {
    await client.close();
  }
});

Deno.test("Events: updateEvent and deleteEvent reject when owner mismatch", async () => {
  const [db, client] = await testDb();
  const events = new EventsConcept(db);
  try {
    const res = await events.createEvent({
      owner: user1,
      title: "Mine",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: new Date("2026-01-01T11:00:00Z"),
      description: ""
    });
    if ("error" in res) throw new Error();

    const updateErr = await events.updateEvent({
      eventId: res.eventId,
      owner: user2,
      title: "Hacked"
    });
    assertEquals("error" in updateErr, true);
    if ("error" in updateErr) assertEquals(updateErr.error, "Not authorized to update this event");

    const deleteErr = await events.deleteEvent({ eventId: res.eventId, owner: user2 });
    assertEquals("error" in deleteErr, true);
    if ("error" in deleteErr) assertEquals(deleteErr.error, "Not authorized to delete this event");
  } finally {
    await client.close();
  }
});
