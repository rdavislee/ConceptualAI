import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import SchedulingConcept, { Resource, Client } from "./SchedulingConcept.ts";

const dentist = "resource:dentist1" as Resource;
const patient1 = "client:patient1" as Client;
const patient2 = "client:patient2" as Client;
const patient3 = "client:patient3" as Client;

Deno.test({
  name: "Scheduling: Add and query availability",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Add availability: 9am-5pm on Jan 1
    const start = new Date("2026-01-01T09:00:00Z");
    const end = new Date("2026-01-01T17:00:00Z");

    const res = await scheduling.addAvailability({ resource: dentist, start, end });
    assertEquals("blockId" in res, true);

    // Query availability
    const blocks = await scheduling._getAvailability({
      resource: dentist,
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-02T00:00:00Z"),
    });
    assertEquals(blocks[0].blocks.length, 1);
    assertEquals(blocks[0].blocks[0].resource, dentist);

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Scheduling: Update availability",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Add availability
    const addRes = await scheduling.addAvailability({
      resource: dentist,
      start: new Date("2026-01-01T09:00:00Z"),
      end: new Date("2026-01-01T17:00:00Z"),
    });
    if ("error" in addRes) throw new Error(addRes.error);

    // Update to different hours
    const updateRes = await scheduling.updateAvailability({
      blockId: addRes.blockId,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T18:00:00Z"),
    });
    assertEquals(updateRes, { ok: true });

    // Verify update
    const blocks = await scheduling._getAvailability({
      resource: dentist,
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-02T00:00:00Z"),
    });
    assertEquals(blocks[0].blocks[0].start.toISOString(), "2026-01-01T10:00:00.000Z");
    assertEquals(blocks[0].blocks[0].end.toISOString(), "2026-01-01T18:00:00.000Z");

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Scheduling: Book appointment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Add availability
    await scheduling.addAvailability({
      resource: dentist,
      start: new Date("2026-01-01T09:00:00Z"),
      end: new Date("2026-01-01T17:00:00Z"),
    });

    // Book appointment: 10am-11am
    const bookRes = await scheduling.book({
      resource: dentist,
      client: patient1,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T11:00:00Z"),
    });
    assertEquals("appointmentId" in bookRes, true);

    // Query appointments
    const appts = await scheduling._getAppointments({
      resource: dentist,
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-02T00:00:00Z"),
    });
    assertEquals(appts[0].appointments.length, 1);
    assertEquals(appts[0].appointments[0].client, patient1);
    assertEquals(appts[0].appointments[0].status, "booked");

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Scheduling: Perfect conflict detection - all overlap scenarios",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Add availability for full day
    await scheduling.addAvailability({
      resource: dentist,
      start: new Date("2026-01-01T08:00:00Z"),
      end: new Date("2026-01-01T18:00:00Z"),
    });

    // Book base appointment: 10am-11am
    const baseAppt = await scheduling.book({
      resource: dentist,
      client: patient1,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T11:00:00Z"),
    });
    assertEquals("appointmentId" in baseAppt, true);

    // Test 1: Exact overlap (10am-11am) - should fail
    const conflict1 = await scheduling.book({
      resource: dentist,
      client: patient2,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T11:00:00Z"),
    });
    assertEquals("error" in conflict1, true);

    // Test 2: Starts before, ends during (9:30am-10:30am) - should fail
    const conflict2 = await scheduling.book({
      resource: dentist,
      client: patient2,
      start: new Date("2026-01-01T09:30:00Z"),
      end: new Date("2026-01-01T10:30:00Z"),
    });
    assertEquals("error" in conflict2, true);

    // Test 3: Starts during, ends after (10:30am-11:30am) - should fail
    const conflict3 = await scheduling.book({
      resource: dentist,
      client: patient2,
      start: new Date("2026-01-01T10:30:00Z"),
      end: new Date("2026-01-01T11:30:00Z"),
    });
    assertEquals("error" in conflict3, true);

    // Test 4: Completely contains (9am-12pm) - should fail
    const conflict4 = await scheduling.book({
      resource: dentist,
      client: patient2,
      start: new Date("2026-01-01T09:00:00Z"),
      end: new Date("2026-01-01T12:00:00Z"),
    });
    assertEquals("error" in conflict4, true);

    // Test 5: Completely contained (10:15am-10:45am) - should fail
    const conflict5 = await scheduling.book({
      resource: dentist,
      client: patient2,
      start: new Date("2026-01-01T10:15:00Z"),
      end: new Date("2026-01-01T10:45:00Z"),
    });
    assertEquals("error" in conflict5, true);

    // Test 6: Adjacent before (9am-10am) - should succeed (no overlap)
    const success1 = await scheduling.book({
      resource: dentist,
      client: patient2,
      start: new Date("2026-01-01T09:00:00Z"),
      end: new Date("2026-01-01T10:00:00Z"),
    });
    assertEquals("appointmentId" in success1, true);

    // Test 7: Adjacent after (11am-12pm) - should succeed (no overlap)
    const success2 = await scheduling.book({
      resource: dentist,
      client: patient3,
      start: new Date("2026-01-01T11:00:00Z"),
      end: new Date("2026-01-01T12:00:00Z"),
    });
    assertEquals("appointmentId" in success2, true);

    // Verify we have exactly 3 appointments
    const allAppts = await scheduling._getAppointments({
      resource: dentist,
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-02T00:00:00Z"),
    });
    assertEquals(allAppts[0].appointments.length, 3);

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Scheduling: Cancel appointment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Add availability and book
    await scheduling.addAvailability({
      resource: dentist,
      start: new Date("2026-01-01T09:00:00Z"),
      end: new Date("2026-01-01T17:00:00Z"),
    });

    const bookRes = await scheduling.book({
      resource: dentist,
      client: patient1,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T11:00:00Z"),
    });
    if ("error" in bookRes) throw new Error(bookRes.error);

    // Cancel
    const cancelRes = await scheduling.cancel({ appointmentId: bookRes.appointmentId });
    assertEquals(cancelRes, { ok: true });

    // Verify status changed
    const appt = await scheduling._getAppointment({ appointmentId: bookRes.appointmentId });
    assertEquals(appt[0].appointment?.status, "cancelled");

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Scheduling: Reschedule appointment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Add availability
    await scheduling.addAvailability({
      resource: dentist,
      start: new Date("2026-01-01T09:00:00Z"),
      end: new Date("2026-01-01T17:00:00Z"),
    });

    // Book appointment: 10am-11am
    const bookRes = await scheduling.book({
      resource: dentist,
      client: patient1,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T11:00:00Z"),
    });
    if ("error" in bookRes) throw new Error(bookRes.error);

    // Reschedule to 2pm-3pm
    const rescheduleRes = await scheduling.reschedule({
      appointmentId: bookRes.appointmentId,
      newStart: new Date("2026-01-01T14:00:00Z"),
      newEnd: new Date("2026-01-01T15:00:00Z"),
    });
    assertEquals(rescheduleRes, { ok: true });

    // Verify new time
    const appt = await scheduling._getAppointment({ appointmentId: bookRes.appointmentId });
    assertEquals(appt[0].appointment?.start.toISOString(), "2026-01-01T14:00:00.000Z");
    assertEquals(appt[0].appointment?.end.toISOString(), "2026-01-01T15:00:00.000Z");

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Scheduling: Client appointments query",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Add availability
    await scheduling.addAvailability({
      resource: dentist,
      start: new Date("2026-01-01T09:00:00Z"),
      end: new Date("2026-01-01T17:00:00Z"),
    });

    // Book multiple appointments for patient1
    await scheduling.book({
      resource: dentist,
      client: patient1,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T11:00:00Z"),
    });
    await scheduling.book({
      resource: dentist,
      client: patient1,
      start: new Date("2026-01-01T14:00:00Z"),
      end: new Date("2026-01-01T15:00:00Z"),
    });

    // Book one for patient2
    await scheduling.book({
      resource: dentist,
      client: patient2,
      start: new Date("2026-01-01T12:00:00Z"),
      end: new Date("2026-01-01T13:00:00Z"),
    });

    // Query patient1's appointments
    const patient1Appts = await scheduling._getClientAppointments({ client: patient1 });
    assertEquals(patient1Appts[0].appointments.length, 2);
    assertEquals(patient1Appts[0].appointments[0].client, patient1);
    assertEquals(patient1Appts[0].appointments[1].client, patient1);

    // Query patient2's appointments
    const patient2Appts = await scheduling._getClientAppointments({ client: patient2 });
    assertEquals(patient2Appts[0].appointments.length, 1);
    assertEquals(patient2Appts[0].appointments[0].client, patient2);

  } finally {
    await client.close();
  }
  },
});

Deno.test({
  name: "Scheduling: Edge cases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scheduling = new SchedulingConcept(db);
  try {
    // Invalid time range
    const err1 = await scheduling.addAvailability({
      resource: dentist,
      start: new Date("2026-01-01T17:00:00Z"),
      end: new Date("2026-01-01T09:00:00Z"),
    });
    assertEquals("error" in err1, true);

    // Book without availability
    const err2 = await scheduling.book({
      resource: dentist,
      client: patient1,
      start: new Date("2026-01-01T10:00:00Z"),
      end: new Date("2026-01-01T11:00:00Z"),
    });
    assertEquals("error" in err2, true);

  } finally {
    await client.close();
  }
  },
});
