import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ReservationsConcept, { CustomerID } from "./ReservationsConcept.ts";

const customer1 = "customer:alice" as CustomerID;
const customer2 = "customer:bob" as CustomerID;
const customer3 = "customer:charlie" as CustomerID;

Deno.test("Reservations: Set capacity and book", async () => {
  const [db, client] = await testDb();
  const reservations = new ReservationsConcept(db);
  try {
    const slot = new Date("2026-01-01T19:00:00Z");

    // Set capacity: 50 seats at 7pm
    await reservations.setCapacity({ timeSlot: slot, maxCapacity: 50 });

    // Book a party of 4
    const booking = await reservations.book({
      customer: customer1,
      timeSlot: slot,
      partySize: 4,
      details: { name: "Alice", phone: "555-1234" },
    });
    assertEquals("bookingId" in booking, true);

    // Verify booking
    const bookings = await reservations._getBookings({ date: new Date("2026-01-01") });
    assertEquals(bookings[0].bookings.length, 1);
    assertEquals(bookings[0].bookings[0].partySize, 4);
    assertEquals(bookings[0].bookings[0].status, "confirmed");

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Reservations: Multiple bookings up to capacity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const reservations = new ReservationsConcept(db);
    try {
      const slot = new Date("2026-01-01T19:00:00Z");

      // Set capacity: 20 seats
      await reservations.setCapacity({ timeSlot: slot, maxCapacity: 20 });

      // Book multiple parties
      await reservations.book({
        customer: customer1,
        timeSlot: slot,
        partySize: 6,
        details: {},
      });
      await reservations.book({
        customer: customer2,
        timeSlot: slot,
        partySize: 8,
        details: {},
      });
      await reservations.book({
        customer: customer3,
        timeSlot: slot,
        partySize: 6,
        details: {},
      });
      // Total: 6 + 8 + 6 = 20 (exactly at capacity)

      const bookings = await reservations._getBookings({
        date: new Date("2026-01-01"),
      });
      assertEquals(bookings[0].bookings.length, 3);
    } finally {
      await client.close();
    }
  },
});

Deno.test("Reservations: Prevent overbooking", async () => {
  const [db, client] = await testDb();
  const reservations = new ReservationsConcept(db);
  try {
    const slot = new Date("2026-01-01T19:00:00Z");

    // Set capacity: 20 seats
    await reservations.setCapacity({ timeSlot: slot, maxCapacity: 20 });

    // Book 18 seats
    await reservations.book({ customer: customer1, timeSlot: slot, partySize: 18, details: {} });

    // Try to book 5 more (would exceed capacity)
    const overbook = await reservations.book({
      customer: customer2,
      timeSlot: slot,
      partySize: 5,
      details: {},
    });
    assertEquals("error" in overbook, true);
    if ("error" in overbook) {
      assertEquals(overbook.error.includes("Insufficient capacity"), true);
    }

    // Book exactly 2 (should succeed)
    const success = await reservations.book({
      customer: customer2,
      timeSlot: slot,
      partySize: 2,
      details: {},
    });
    assertEquals("bookingId" in success, true);

  } finally {
    await client.close();
  }
});

Deno.test("Reservations: Cancel booking frees capacity", async () => {
  const [db, client] = await testDb();
  const reservations = new ReservationsConcept(db);
  try {
    const slot = new Date("2026-01-01T19:00:00Z");

    // Set capacity: 10 seats
    await reservations.setCapacity({ timeSlot: slot, maxCapacity: 10 });

    // Book 10 seats
    const booking1 = await reservations.book({
      customer: customer1,
      timeSlot: slot,
      partySize: 10,
      details: {},
    });
    if ("error" in booking1) throw new Error(booking1.error);

    // Try to book more (should fail)
    const fail = await reservations.book({
      customer: customer2,
      timeSlot: slot,
      partySize: 5,
      details: {},
    });
    assertEquals("error" in fail, true);

    // Cancel first booking
    await reservations.cancel({ bookingId: booking1.bookingId });

    // Now booking should succeed
    const success = await reservations.book({
      customer: customer2,
      timeSlot: slot,
      partySize: 5,
      details: {},
    });
    assertEquals("bookingId" in success, true);

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Reservations: Get availability",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const reservations = new ReservationsConcept(db);
    try {
      const date = new Date("2026-01-01");
      const slot1 = new Date("2026-01-01T18:00:00Z");
      const slot2 = new Date("2026-01-01T19:00:00Z");
      const slot3 = new Date("2026-01-01T20:00:00Z");

      // Set capacities
      await reservations.setCapacity({ timeSlot: slot1, maxCapacity: 20 });
      await reservations.setCapacity({ timeSlot: slot2, maxCapacity: 30 });
      await reservations.setCapacity({ timeSlot: slot3, maxCapacity: 15 });

      // Book some seats
      await reservations.book({
        customer: customer1,
        timeSlot: slot1,
        partySize: 18,
        details: {},
      }); // 2 left
      await reservations.book({
        customer: customer1,
        timeSlot: slot2,
        partySize: 10,
        details: {},
      }); // 20 left
      await reservations.book({
        customer: customer1,
        timeSlot: slot3,
        partySize: 15,
        details: {},
      }); // 0 left

      // Check availability for party of 5
      const available = await reservations._getAvailability({ date, partySize: 5 });
      assertEquals(available[0].slots.length, 1); // Only slot2 has room for 5
      assertEquals(available[0].slots[0].toISOString(), slot2.toISOString());
    } finally {
      await client.close();
    }
  },
});

Deno.test("Reservations: Get customer bookings", async () => {
  const [db, client] = await testDb();
  const reservations = new ReservationsConcept(db);
  try {
    const slot1 = new Date("2026-01-01T19:00:00Z");
    const slot2 = new Date("2026-01-02T19:00:00Z");

    await reservations.setCapacity({ timeSlot: slot1, maxCapacity: 50 });
    await reservations.setCapacity({ timeSlot: slot2, maxCapacity: 50 });

    // Customer1 makes 2 bookings
    await reservations.book({ customer: customer1, timeSlot: slot1, partySize: 4, details: {} });
    await reservations.book({ customer: customer1, timeSlot: slot2, partySize: 6, details: {} });

    // Customer2 makes 1 booking
    await reservations.book({ customer: customer2, timeSlot: slot1, partySize: 2, details: {} });

    // Query customer1's bookings
    const customer1Bookings = await reservations._getCustomerBookings({ customer: customer1 });
    assertEquals(customer1Bookings[0].bookings.length, 2);

    // Query customer2's bookings
    const customer2Bookings = await reservations._getCustomerBookings({ customer: customer2 });
    assertEquals(customer2Bookings[0].bookings.length, 1);

  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Reservations: Edge cases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const reservations = new ReservationsConcept(db);
    try {
      const slot = new Date("2026-01-01T19:00:00Z");

      // Invalid capacity
      const err1 = await reservations.setCapacity({ timeSlot: slot, maxCapacity: 0 });
      assertEquals("error" in err1, true);

      // Invalid party size
      const err2 = await reservations.book({
        customer: customer1,
        timeSlot: slot,
        partySize: 0,
        details: {},
      });
      assertEquals("error" in err2, true);

      // Book without capacity set
      const err3 = await reservations.book({
        customer: customer1,
        timeSlot: new Date("2026-01-02T19:00:00Z"),
        partySize: 4,
        details: {},
      });
      assertEquals("error" in err3, true);
    } finally {
      await client.close();
    }
  },
});
