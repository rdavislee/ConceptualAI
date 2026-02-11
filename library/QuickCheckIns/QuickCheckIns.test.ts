import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import QuickCheckInsConcept from "./QuickCheckInsConcept.ts";

const userAlice = "user:Alice" as ID;
const userBob = "user:Bob" as ID;
const userCharlie = "user:Charlie" as ID;

Deno.test("Principle: A user logs outcomes (check-ins) for metrics, and the concept stores these facts.", async () => {
  const [db, client] = await testDb();
  const concept = new QuickCheckInsConcept(db);

  try {
    // 1. Define internal metrics (e.g., energy, mood)
    console.log("Defining 'Energy' metric...");
    const defineEnergyMetricResult = await concept.defineMetric({
      owner: userAlice,
      name: "Energy",
    });
    assertNotEquals(
      "error" in defineEnergyMetricResult,
      true,
      "Defining 'Energy' metric should succeed.",
    );
    const { metric: energyMetricId } = defineEnergyMetricResult as {
      metric: ID;
    };
    assertExists(energyMetricId, "Energy metric ID should be returned.");

    console.log("Defining 'Mood' metric...");
    const defineMoodMetricResult = await concept.defineMetric({
      owner: userAlice,
      name: "Mood",
    });
    assertNotEquals(
      "error" in defineMoodMetricResult,
      true,
      "Defining 'Mood' metric should succeed.",
    );
    const { metric: moodMetricId } = defineMoodMetricResult as { metric: ID };
    assertExists(moodMetricId, "Mood metric ID should be returned.");

    // 2. User Alice logs outcomes (check-ins) for different metrics at different times
    const now1 = new Date("2023-01-01T10:00:00Z");
    console.log(
      `User Alice records Energy check-in at ${now1.toISOString()}...`,
    );
    const record1Result = await concept.record({
      owner: userAlice,
      at: now1,
      metric: energyMetricId,
      value: 8,
    });
    assertNotEquals(
      "error" in record1Result,
      true,
      "First check-in record should succeed.",
    );
    const { checkIn: checkIn1 } = record1Result as { checkIn: ID };
    assertExists(checkIn1, "First check-in ID should be returned.");

    const now2 = new Date("2023-01-01T14:00:00Z");
    console.log(`User Alice records Mood check-in at ${now2.toISOString()}...`);
    const record2Result = await concept.record({
      owner: userAlice,
      at: now2,
      metric: moodMetricId,
      value: 7,
    });
    assertNotEquals(
      "error" in record2Result,
      true,
      "Second check-in record should succeed.",
    );
    const { checkIn: checkIn2 } = record2Result as { checkIn: ID };
    assertExists(checkIn2, "Second check-in ID should be returned.");

    // 3. Verify the concept stores these facts by retrieving Alice's check-ins
    console.log("Retrieving Alice's check-ins...");
    const aliceCheckIns = await concept._listCheckInsByOwner({
      owner: userAlice,
    });
    assertEquals(
      aliceCheckIns.length,
      2,
      "Alice should have two check-ins recorded.",
    );

    const retrievedCheckIn1 = aliceCheckIns.find((ci) => ci._id === checkIn1);
    assertExists(retrievedCheckIn1, "First check-in should be found.");
    assertEquals(
      retrievedCheckIn1.owner,
      userAlice,
      "Check-in 1 owner should be Alice.",
    );
    assertEquals(
      retrievedCheckIn1.at.toISOString(),
      now1.toISOString(),
      "Check-in 1 timestamp should match.",
    );
    assertEquals(
      retrievedCheckIn1.metric,
      energyMetricId,
      "Check-in 1 metric should be Energy.",
    );
    assertEquals(retrievedCheckIn1.value, 8, "Check-in 1 value should be 8.");

    const retrievedCheckIn2 = aliceCheckIns.find((ci) => ci._id === checkIn2);
    assertExists(retrievedCheckIn2, "Second check-in should be found.");
    assertEquals(
      retrievedCheckIn2.owner,
      userAlice,
      "Check-in 2 owner should be Alice.",
    );
    assertEquals(
      retrievedCheckIn2.at.toISOString(),
      now2.toISOString(),
      "Check-in 2 timestamp should match.",
    );
    assertEquals(
      retrievedCheckIn2.metric,
      moodMetricId,
      "Check-in 2 metric should be Mood.",
    );
    assertEquals(retrievedCheckIn2.value, 7, "Check-in 2 value should be 7.");
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Action: defineMetric - success and requirements enforcement",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new QuickCheckInsConcept(db);

    try {
    // Test Case 1: Success - Define a new metric
    console.log("Attempting to define a new metric 'Sleep Quality'...");
    const result1 = await concept.defineMetric({
      owner: userAlice,
      name: "Sleep Quality",
    });
    assertNotEquals(
      "error" in result1,
      true,
      "Defining a new metric should succeed.",
    );
    const { metric: sleepMetricId } = result1 as { metric: ID };
    assertExists(sleepMetricId, "A metric ID should be returned.");

    // Verify the metric exists
    const retrievedMetric = await concept._getMetricsByName({
      owner: userAlice,
      name: "Sleep Quality",
    });
    assertExists(
      retrievedMetric,
      "The newly defined metric should be retrievable by name.",
    );
    assertEquals(
      retrievedMetric._id,
      sleepMetricId,
      "Retrieved metric ID should match.",
    );
    assertEquals(
      retrievedMetric.name,
      "Sleep Quality",
      "Retrieved metric name should match.",
    );

    // Test Case 2: Requires - No InternalMetric with 'name' exists (attempt to define duplicate)
    console.log("Attempting to define 'Sleep Quality' again (should fail)...");
    const result2 = await concept.defineMetric({
      owner: userAlice,
      name: "Sleep Quality",
    });
    assertEquals(
      "error" in result2,
      true,
      "Defining a metric with an existing name should fail.",
    );
    assertEquals(
      (result2 as { error: string }).error,
      `Metric with name 'Sleep Quality' already exists with ID '${sleepMetricId}'.`,
      "Error message should indicate duplicate name and provide existing ID.",
    );
    } finally {
      await client.close();
    }
  },
});

Deno.test("Action: record - success and requirements enforcement", async () => {
  const [db, client] = await testDb();
  const concept = new QuickCheckInsConcept(db);

  try {
    // Setup: Define a valid metric for testing
    console.log("Defining 'Hunger' metric for recording tests...");
    const { metric: hungerMetricId } =
      (await concept.defineMetric({ owner: userAlice, name: "Hunger" })) as {
        metric: ID;
      };
    const now = new Date();

    // Test Case 1: Success - Record a valid check-in
    console.log("Recording a valid check-in for 'Hunger'...");
    const recordResult = await concept.record({
      owner: userAlice,
      at: now,
      metric: hungerMetricId,
      value: 5,
    });
    assertNotEquals(
      "error" in recordResult,
      true,
      "Recording a valid check-in should succeed.",
    );
    const { checkIn: newCheckInId } = recordResult as { checkIn: ID };
    assertExists(newCheckInId, "A check-in ID should be returned.");

    // Verify the recorded check-in
    const retrievedCheckIn = await concept._getCheckIn({
      checkIn: newCheckInId,
    });
    assertExists(
      retrievedCheckIn,
      "The newly recorded check-in should be retrievable.",
    );
    assertEquals(
      retrievedCheckIn.owner,
      userAlice,
      "Check-in owner should match.",
    );
    assertEquals(
      retrievedCheckIn.at.toISOString(),
      now.toISOString(),
      "Check-in timestamp should match.",
    );
    assertEquals(
      retrievedCheckIn.metric,
      hungerMetricId,
      "Check-in metric should match.",
    );
    assertEquals(retrievedCheckIn.value, 5, "Check-in value should match.");

    // Test Case 2: Requires - The InternalMetric 'metric' exists (attempt to record with non-existent metric)
    const nonExistentMetricId = "metric:fake_nonexistent" as ID;
    console.log(
      `Attempting to record with non-existent metric ID '${nonExistentMetricId}' (should fail)...`,
    );
    const invalidRecordResult = await concept.record({
      owner: userAlice,
      at: now,
      metric: nonExistentMetricId,
      value: 3,
    });
    assertEquals(
      "error" in invalidRecordResult,
      true,
      "Recording with a non-existent metric should fail.",
    );
    assertEquals(
      (invalidRecordResult as { error: string }).error,
      `Metric with ID '${nonExistentMetricId}' is not defined.`,
      "Error message should indicate undefined metric.",
    );
  } finally {
    await client.close();
  }
});

Deno.test("Action: edit - requirements enforcement (non-existent check-in, unauthorized owner, non-existent new metric)", async () => {
  const [db, client] = await testDb();
  const concept = new QuickCheckInsConcept(db);

  try {
    // Setup: Define metrics and record an initial check-in for Alice
    console.log("Setup: Defining initial and updated metrics...");
    const { metric: initialMetric } = (await concept.defineMetric({
      owner: userAlice,
      name: "InitialMetric",
    })) as { metric: ID };
    const { metric: _updatedMetric } = (await concept.defineMetric({
      owner: userAlice,
      name: "UpdatedMetric",
    })) as { metric: ID };
    const { checkIn: checkInId } = (await concept.record({
      owner: userAlice,
      at: new Date(),
      metric: initialMetric,
      value: 10,
    })) as { checkIn: ID };
    assertExists(checkInId, "Initial check-in should be created.");

    // Test Case 1: Requires - The CheckIn 'checkIn' exists (attempt to edit non-existent check-in)
    const nonExistentCheckInId = "checkin:fake_missing" as ID;
    console.log(
      `Attempting to edit non-existent check-in ID '${nonExistentCheckInId}' (should fail)...`,
    );
    const res1 = await concept.edit({
      checkIn: nonExistentCheckInId,
      owner: userAlice,
      value: 5,
    });
    assertEquals(
      "error" in res1,
      true,
      "Editing a non-existent check-in should fail.",
    );
    assertEquals(
      (res1 as { error: string }).error,
      `Check-in with ID '${nonExistentCheckInId}' not found.`,
      "Error message should indicate check-in not found.",
    );

    // Test Case 2: Requires - owner of 'checkIn' is 'owner' (attempt to edit by non-owner)
    console.log(
      `Attempting to edit check-in '${checkInId}' by non-owner Bob (should fail)...`,
    );
    const res2 = await concept.edit({
      checkIn: checkInId,
      owner: userBob,
      value: 5,
    });
    assertEquals("error" in res2, true, "Editing by a non-owner should fail.");
    assertEquals(
      (res2 as { error: string }).error,
      "You are not the owner of this check-in.",
      "Error message should indicate unauthorized access.",
    );

    // Test Case 3: Requires - if 'metric' is provided, then the InternalMetric 'metric' exists (update to non-existent metric)
    const nonExistentNewMetricId = "metric:another_fake_missing" as ID;
    console.log(
      `Attempting to update check-in '${checkInId}' metric to non-existent ID '${nonExistentNewMetricId}' (should fail)...`,
    );
    const res3 = await concept.edit({
      checkIn: checkInId,
      owner: userAlice,
      metric: nonExistentNewMetricId,
    });
    assertEquals(
      "error" in res3,
      true,
      "Updating to a non-existent metric should fail.",
    );
    assertEquals(
      (res3 as { error: string }).error,
      `New metric with ID '${nonExistentNewMetricId}' is not defined.`,
      "Error message should indicate the new metric is not defined.",
    );
  } finally {
    await client.close();
  }
});

Deno.test({
  name:
    "Action: edit - effects verification (update value, update metric, update both, no-op)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new QuickCheckInsConcept(db);

    try {
    // Setup: Define metrics and record an initial check-in for Alice
    console.log(
      "Setup: Defining metrics and initial check-in for edit effects tests...",
    );
    const { metric: metricA } =
      (await concept.defineMetric({ owner: userAlice, name: "MetricA" })) as {
        metric: ID;
      };
    const { metric: metricB } =
      (await concept.defineMetric({ owner: userAlice, name: "MetricB" })) as {
        metric: ID;
      };
    const { checkIn: checkInId } = (await concept.record({
      owner: userAlice,
      at: new Date(),
      metric: metricA,
      value: 10,
    })) as { checkIn: ID };
    assertExists(checkInId, "Initial check-in should be created.");

    // Test Case 1: Effects - Update value only
    console.log(`Updating value of check-in '${checkInId}' to 5...`);
    const editValueResult = await concept.edit({
      checkIn: checkInId,
      owner: userAlice,
      value: 5,
    });
    assertNotEquals(
      "error" in editValueResult,
      true,
      "Updating value should succeed.",
    );
    let retrievedCheckIn = await concept._getCheckIn({ checkIn: checkInId });
    assertExists(retrievedCheckIn);
    assertEquals(retrievedCheckIn.value, 5, "Value should be updated to 5.");
    assertEquals(
      retrievedCheckIn.metric,
      metricA,
      "Metric should remain unchanged.",
    ); // Ensure other fields are untouched

    // Test Case 2: Effects - Update metric only
    console.log(`Updating metric of check-in '${checkInId}' to MetricB...`);
    const editMetricResult = await concept.edit({
      checkIn: checkInId,
      owner: userAlice,
      metric: metricB,
    });
    assertNotEquals(
      "error" in editMetricResult,
      true,
      "Updating metric should succeed.",
    );
    retrievedCheckIn = await concept._getCheckIn({ checkIn: checkInId });
    assertExists(retrievedCheckIn);
    assertEquals(retrievedCheckIn.value, 5, "Value should remain unchanged."); // Ensure other fields are untouched
    assertEquals(
      retrievedCheckIn.metric,
      metricB,
      "Metric should be updated to MetricB.",
    );

    // Test Case 3: Effects - Update both metric and value
    console.log(
      `Updating both metric to MetricA and value to 9 for check-in '${checkInId}'...`,
    );
    const editBothResult = await concept.edit({
      checkIn: checkInId,
      owner: userAlice,
      metric: metricA,
      value: 9,
    });
    assertNotEquals(
      "error" in editBothResult,
      true,
      "Updating both metric and value should succeed.",
    );
    retrievedCheckIn = await concept._getCheckIn({ checkIn: checkInId });
    assertExists(retrievedCheckIn);
    assertEquals(retrievedCheckIn.value, 9, "Value should be updated to 9.");
    assertEquals(
      retrievedCheckIn.metric,
      metricA,
      "Metric should be updated to MetricA.",
    );

    // Test Case 4: No updates - Call edit without metric or value (no-op)
    console.log(
      `Calling edit on check-in '${checkInId}' without any updates (should succeed with no changes)...`,
    );
    const noUpdateResult = await concept.edit({
      checkIn: checkInId,
      owner: userAlice,
    });
    assertNotEquals(
      "error" in noUpdateResult,
      true,
      "Calling edit without any updates should succeed (no actual change).",
    );
    retrievedCheckIn = await concept._getCheckIn({ checkIn: checkInId }); // Verify no unintended changes
    assertExists(retrievedCheckIn);
    assertEquals(
      retrievedCheckIn.value,
      9,
      "Value should still be 9 after no-op edit.",
    );
    assertEquals(
      retrievedCheckIn.metric,
      metricA,
      "Metric should still be MetricA after no-op edit.",
    );
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name:
    "Queries: _getCheckIn, _getMetricsByName, _listCheckInsByOwner functionality",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new QuickCheckInsConcept(db);

    try {
    // Setup: Define multiple metrics and record check-ins for multiple users
    const { metric: energyAliceId } =
      (await concept.defineMetric({ owner: userAlice, name: "Energy" })) as {
        metric: ID;
      };
    const { metric: focusAliceId } =
      (await concept.defineMetric({ owner: userAlice, name: "Focus" })) as {
        metric: ID;
      };
    const { metric: energyBobId } =
      (await concept.defineMetric({ owner: userBob, name: "Energy" })) as {
        metric: ID;
      };

    const checkIn1Alice = (await concept.record({
      owner: userAlice,
      at: new Date("2023-03-01T08:00:00Z"),
      metric: energyAliceId,
      value: 7,
    })) as { checkIn: ID };
    const checkIn2Alice = (await concept.record({
      owner: userAlice,
      at: new Date("2023-03-01T10:00:00Z"),
      metric: focusAliceId,
      value: 6,
    })) as { checkIn: ID };
    const checkIn1Bob = (await concept.record({
      owner: userBob,
      at: new Date("2023-03-01T09:00:00Z"),
      metric: energyBobId,
      value: 5,
    })) as { checkIn: ID };

    // Query: _getCheckIn
    console.log(`Querying for check-in '${checkIn1Alice.checkIn}'...`);
    const retrievedAliceCheckIn1 = await concept._getCheckIn({
      checkIn: checkIn1Alice.checkIn,
    });
    assertExists(
      retrievedAliceCheckIn1,
      "Alice's first check-in should be found by ID.",
    );
    assertEquals(
      retrievedAliceCheckIn1.owner,
      userAlice,
      "Retrieved check-in owner should match.",
    );

    console.log("Querying for a non-existent check-in...");
    const nonExistentCheckIn = await concept._getCheckIn({
      checkIn: "checkin:nonexistent" as ID,
    });
    assertEquals(
      nonExistentCheckIn,
      null,
      "Query for non-existent check-in should return null.",
    );

    // Query: _getMetricsByName
    console.log("Querying for metric 'Energy' by name...");
    const retrievedEnergyMetric = await concept._getMetricsByName({
      owner: userAlice,
      name: "Energy",
    });
    assertExists(
      retrievedEnergyMetric,
      "Energy metric should be found by name.",
    );
    assertEquals(
      retrievedEnergyMetric._id,
      energyAliceId,
      "Retrieved Energy metric ID should match.",
    );

    console.log("Querying for a non-existent metric by name...");
    const nonExistentMetric = await concept._getMetricsByName({
      owner: userAlice,
      name: "NonExistentMetric",
    });
    assertEquals(
      nonExistentMetric,
      null,
      "Query for non-existent metric should return null.",
    );

    // Query: _listCheckInsByOwner
    console.log(`Listing check-ins for owner '${userAlice}'...`);
    const aliceCheckIns = await concept._listCheckInsByOwner({
      owner: userAlice,
    });
    assertEquals(aliceCheckIns.length, 2, "Alice should have 2 check-ins.");
    assertEquals(
      aliceCheckIns.some((ci) => ci._id === checkIn1Alice.checkIn),
      true,
      "Alice's first check-in should be in the list.",
    );
    assertEquals(
      aliceCheckIns.some((ci) => ci._id === checkIn2Alice.checkIn),
      true,
      "Alice's second check-in should be in the list.",
    );
    assertEquals(
      aliceCheckIns.every((ci) => ci.owner === userAlice),
      true,
      "All listed check-ins should belong to Alice.",
    );

    console.log(`Listing check-ins for owner '${userBob}'...`);
    const bobCheckIns = await concept._listCheckInsByOwner({ owner: userBob });
    assertEquals(bobCheckIns.length, 1, "Bob should have 1 check-in.");
    assertEquals(
      bobCheckIns[0]._id,
      checkIn1Bob.checkIn,
      "Bob's check-in should be found.",
    );

    console.log(
      `Listing check-ins for owner '${userCharlie}' (no check-ins)...`,
    );
    const charlieCheckIns = await concept._listCheckInsByOwner({
      owner: userCharlie,
    });
    assertEquals(charlieCheckIns.length, 0, "Charlie should have 0 check-ins.");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Action: delete - success, non-owner, and missing check-in",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new QuickCheckInsConcept(db);

    try {
    // Setup: define a metric and create two check-ins for Alice and Bob
    const { metric: aliceMetric } = (await concept.defineMetric({
      owner: userAlice,
      name: "TempMetric",
    })) as { metric: ID };
    const { metric: bobMetric } = (await concept.defineMetric({
      owner: userBob,
      name: "TempMetric",
    })) as { metric: ID };
    const { checkIn: aliceCheckIn } = (await concept.record({
      owner: userAlice,
      at: new Date("2025-10-30T10:00:00Z"),
      metric: aliceMetric,
      value: 3,
    })) as { checkIn: ID };
    const { checkIn: bobCheckIn } = (await concept.record({
      owner: userBob,
      at: new Date("2025-10-30T11:00:00Z"),
      metric: bobMetric,
      value: 6,
    })) as { checkIn: ID };

    // Success: owner deletes their own check-in
    const delOk = await concept.delete({
      checkIn: aliceCheckIn,
      owner: userAlice,
    });
    assertEquals(
      "error" in delOk,
      false,
      "Owner should be able to delete their check-in.",
    );
    const afterDelete = await concept._getCheckIn({ checkIn: aliceCheckIn });
    assertEquals(afterDelete, null, "Deleted check-in should not be found.");

    // Non-owner cannot delete
    const delUnauthorized = await concept.delete({
      checkIn: bobCheckIn,
      owner: userAlice,
    });
    assertEquals("error" in delUnauthorized, true);
    assertEquals(
      (delUnauthorized as { error: string }).error,
      "You are not the owner of this check-in.",
    );
    const bobStillThere = await concept._getCheckIn({ checkIn: bobCheckIn });
    assertExists(
      bobStillThere,
      "Bob's check-in should still exist after unauthorized attempt.",
    );

    // Missing check-in returns error
    const delMissing = await concept.delete({
      checkIn: "checkin:missing" as ID,
      owner: userAlice,
    });
    assertEquals("error" in delMissing, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Action: deleteByOwner removes all check-ins and metrics for owner",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new QuickCheckInsConcept(db);

    try {
    const { metric: m1 } = (await concept.defineMetric({ owner: userAlice, name: "M1" })) as { metric: ID };
    const { metric: m2 } = (await concept.defineMetric({ owner: userAlice, name: "M2" })) as { metric: ID };
    await concept.record({ owner: userAlice, at: new Date(), metric: m1, value: 1 });
    await concept.record({ owner: userAlice, at: new Date(), metric: m2, value: 2 });

    const res = await concept.deleteByOwner({ owner: userAlice });
    assertEquals(res.checkIns, 2);
    assertEquals(res.metrics, 2);

    const after = await concept._listCheckInsByOwner({ owner: userAlice });
    assertEquals(after.length, 0);
    const metricsAfter = await concept._listMetricsForOwner({ owner: userAlice });
    assertEquals(metricsAfter.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test("Action: deleteCheckInsByMetric removes all check-ins for metric", async () => {
  const [db, client] = await testDb();
  const concept = new QuickCheckInsConcept(db);

  try {
    const defineRes = await concept.defineMetric({ owner: userAlice, name: "M" });
    if ("error" in defineRes) throw new Error(defineRes.error);
    const { metric } = defineRes;

    const r1 = await concept.record({ owner: userAlice, at: new Date(), metric, value: 1 });
    if ("error" in r1) throw new Error(r1.error);
    const r2 = await concept.record({ owner: userAlice, at: new Date(), metric, value: 2 });
    if ("error" in r2) throw new Error(r2.error);

    const before = await concept._listCheckInsByOwner({ owner: userAlice });
    assertEquals(before.length, 2, "Should have 2 check-ins before delete");

    const res = await concept.deleteCheckInsByMetric({ metric });
    assertEquals(res.deleted, 2);

    const after = await concept._listCheckInsByOwner({ owner: userAlice });
    assertEquals(after.length, 0);
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "Action: deleteMetric prevents delete when in use and succeeds when unused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new QuickCheckInsConcept(db);

    try {
    // Create a metric and a check-in referencing it
    const { metric } = (await concept.defineMetric({
      owner: userAlice,
      name: "ToDelete",
    })) as {
      metric: ID;
    };
    const _ci = await concept.record({
      owner: userAlice,
      at: new Date("2025-10-30T12:00:00Z"),
      metric,
      value: 4,
    });

    // Attempt to delete while in use
    const blocked = await concept.deleteMetric({ requester: userAlice, metric });
    assertEquals("error" in blocked, true);

    // Remove referencing check-in, then delete metric
    const { checkIn } = (await concept.record({
      owner: userAlice,
      at: new Date("2025-10-30T13:00:00Z"),
      metric,
      value: 2,
    })) as { checkIn: ID };
    await concept.delete({ checkIn, owner: userAlice });
    // Also ensure previous check-in is removed to free the metric
    const allAlice = await concept._listCheckInsByOwner({ owner: userAlice });
    for (const c of allAlice) {
      if (c.metric === metric) {
        await concept.delete({ checkIn: c._id, owner: userAlice });
      }
    }

    const ok = await concept.deleteMetric({ requester: userAlice, metric });
    assertEquals("error" in ok, false);
    } finally {
      await client.close();
    }
  },
});
