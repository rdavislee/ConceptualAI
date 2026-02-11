import { assertEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import ScoringConcept, { Subject, Context } from "./ScoringConcept.ts";

const subject1 = "user:1" as Subject;
const subject2 = "user:2" as Subject;
const contextA = "game:1" as Context;
const contextB = "game:2" as Context;

Deno.test({
  name: "Scoring: Basic set/get operations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  try {
    // 1. Set score
    await scoring.setScore({ subject: subject1, context: contextA, value: 100 });
    const score1 = await scoring._getScore({ subject: subject1, context: contextA });
    assertEquals(score1[0].value, 100);

    // 2. Default score is 0
    const score2 = await scoring._getScore({ subject: subject2, context: contextA });
    assertEquals(score2[0].value, 0);

    // 3. Different context isolated
    const score3 = await scoring._getScore({ subject: subject1, context: contextB });
    assertEquals(score3[0].value, 0);

  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Scoring: Add operations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  try {
    // 1. Add to non-existent (0 + 50)
    await scoring.addScore({ subject: subject1, context: contextA, delta: 50 });
    const score1 = await scoring._getScore({ subject: subject1, context: contextA });
    assertEquals(score1[0].value, 50);

    // 2. Add to existing (50 + 25)
    await scoring.addScore({ subject: subject1, context: contextA, delta: 25 });
    const score2 = await scoring._getScore({ subject: subject1, context: contextA });
    assertEquals(score2[0].value, 75);

    // 3. Decrement (75 - 10)
    await scoring.addScore({ subject: subject1, context: contextA, delta: -10 });
    const score3 = await scoring._getScore({ subject: subject1, context: contextA });
    assertEquals(score3[0].value, 65);

  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Scoring: Remove operation",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  try {
    // 1. Set a score
    await scoring.setScore({ subject: subject1, context: contextA, value: 100 });
    const score1 = await scoring._getScore({ subject: subject1, context: contextA });
    assertEquals(score1[0].value, 100);

    // 2. Remove deletes the score
    await scoring.remove({ subject: subject1, context: contextA });
    const score2 = await scoring._getScore({ subject: subject1, context: contextA });
    assertEquals(score2[0].value, 0); // Returns default 0

    // 3. Remove non-existent returns error
    const err = await scoring.remove({ subject: subject2, context: contextB });
    assertEquals("error" in err, true);

  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Scoring: Leaderboard",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  try {
    await scoring.setScore({ subject: subject1, context: contextA, value: 100 });
    await scoring.setScore({ subject: subject2, context: contextA, value: 200 });
    // Another subject in context A
    await scoring.setScore({ subject: "user:3" as Subject, context: contextA, value: 50 });
    // Subject in different context
    await scoring.setScore({ subject: subject1, context: contextB, value: 500 }); // Should not appear

    // 1. Descending (default for high scores)
    const board1 = await scoring._getLeaderboard({ context: contextA, limit: 10 });
    assertEquals(board1[0].scores.length, 3);
    assertEquals(board1[0].scores[0].subject, subject2); // 200
    assertEquals(board1[0].scores[0].value, 200);
    assertEquals(board1[0].scores[1].subject, subject1); // 100
    assertEquals(board1[0].scores[2].subject, "user:3"); // 50

    // 2. Limit
    const board2 = await scoring._getLeaderboard({ context: contextA, limit: 1 });
    assertEquals(board2[0].scores.length, 1);
    assertEquals(board2[0].scores[0].subject, subject2);

    // 3. Ascending (e.g., race times)
    const board3 = await scoring._getLeaderboard({ context: contextA, limit: 10, ascending: true });
    assertEquals(board3[0].scores[0].subject, "user:3"); // 50
    assertEquals(board3[0].scores[1].subject, subject1); // 100
    assertEquals(board3[0].scores[2].subject, subject2); // 200

  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Action: spend",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  const user = "user:1" as Subject;
  const context = "context:money" as Context;

  try {
    // 1. Setup initial balance
    await scoring.setScore({ subject: user, context, value: 100 });

    // 2. Spend valid amount
    const res1 = await scoring.spend({ subject: user, context, amount: 40 });
    assertEquals("ok" in res1, true, "Spend should succeed");

    const balance1 = await scoring._getScore({ subject: user, context });
    assertEquals(balance1[0].value, 60);

    // 3. Spend invalid amount (insufficient funds)
    const res2 = await scoring.spend({ subject: user, context, amount: 70 });
    assertEquals("error" in res2, true, "Spend should fail with insufficient funds");

    const balance2 = await scoring._getScore({ subject: user, context });
    assertEquals(balance2[0].value, 60, "Balance should remain unchanged");

    // 4. Spend negative amount
    const res3 = await scoring.spend({ subject: user, context, amount: -10 });
    assertEquals("error" in res3, true, "Spend should fail with negative amount");

  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Action: transfer",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  const sender = "user:A" as Subject;
  const receiver = "user:B" as Subject;
  const context = "context:money" as Context;

  try {
    // 1. Setup
    await scoring.setScore({ subject: sender, context, value: 100 });
    await scoring.setScore({ subject: receiver, context, value: 0 });

    // 2. Transfer valid amount
    const res1 = await scoring.transfer({ from: sender, to: receiver, context, amount: 30 });
    assertEquals("ok" in res1, true, "Transfer should succeed");

    const senderBal1 = await scoring._getScore({ subject: sender, context });
    const receiverBal1 = await scoring._getScore({ subject: receiver, context });
    assertEquals(senderBal1[0].value, 70);
    assertEquals(receiverBal1[0].value, 30);

    // 3. Transfer insufficient funds
    const res2 = await scoring.transfer({ from: sender, to: receiver, context, amount: 80 });
    assertEquals("error" in res2, true, "Transfer should fail with insufficient funds");

    // 4. Transfer negative
    const res3 = await scoring.transfer({ from: sender, to: receiver, context, amount: -10 });
    assertEquals("error" in res3, true, "Transfer should fail with negative amount");

  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Scoring: deleteBySubject",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  try {
    await scoring.setScore({ subject: subject1, context: contextA, value: 100 });
    await scoring.setScore({ subject: subject1, context: contextB, value: 50 });
    await scoring.setScore({ subject: subject2, context: contextA, value: 200 });

    const res = await scoring.deleteBySubject({ subject: subject1 });
    assertEquals("ok" in res, true);

    assertEquals((await scoring._getScore({ subject: subject1, context: contextA }))[0].value, 0);
    assertEquals((await scoring._getScore({ subject: subject1, context: contextB }))[0].value, 0);
    assertEquals((await scoring._getScore({ subject: subject2, context: contextA }))[0].value, 200);
  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Scoring: deleteByContext",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  try {
    await scoring.setScore({ subject: subject1, context: contextA, value: 100 });
    await scoring.setScore({ subject: subject2, context: contextA, value: 200 });
    await scoring.setScore({ subject: subject1, context: contextB, value: 50 });

    const res = await scoring.deleteByContext({ context: contextA });
    assertEquals("ok" in res, true);

    assertEquals((await scoring._getScore({ subject: subject1, context: contextA }))[0].value, 0);
    assertEquals((await scoring._getScore({ subject: subject2, context: contextA }))[0].value, 0);
    assertEquals((await scoring._getScore({ subject: subject1, context: contextB }))[0].value, 50);
  } finally {
    await client.close();
  }
}});

Deno.test({
  name: "Concurrency: Preventing Double Spend",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
  const [db, client] = await testDb();
  const scoring = new ScoringConcept(db);
  const user = "user:race" as Subject;
  const context = "context:race" as Context;

  try {
    // 1. Setup - User has 100
    await scoring.setScore({ subject: user, context, value: 100 });

    // 2. Try to spend 60 twice concurrently (total 120 > 100)
    // Both would succeed with read-then-write logic if timing is tight
    const attemptSpend = () => scoring.spend({ subject: user, context, amount: 60 });

    // Launch both promises simultaneously
    const results = await Promise.all([attemptSpend(), attemptSpend()]);

    // 3. Verify exactly one succeeded and one failed
    const successCount = results.filter(r => "ok" in r).length;
    const failureCount = results.filter(r => "error" in r).length;

    assertEquals(successCount, 1, "Exactly one spend should succeed");
    assertEquals(failureCount, 1, "Exactly one spend should fail");

    // 4. Verify final balance is 40 (100 - 60)
    const balance = await scoring._getScore({ subject: user, context });
    assertEquals(balance[0].value, 40);

  } finally {
    await client.close();
  }
}});
