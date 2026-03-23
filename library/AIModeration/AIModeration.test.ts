import { assertEquals, assertExists } from "jsr:@std/assert";
import { freshID, testDb } from "@utils/database.ts";
import AIModerationConcept, {
  Item,
  ModerationPolicy,
  Owner,
} from "./AIModerationConcept.ts";

const owner = freshID() as Owner;
const item1 = freshID() as Item;
const item2 = freshID() as Item;

Deno.test({
  name: "AIModeration: moderate, queries, flagged items, cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIModerationConcept(db);
  try {
    const created = await concept.createPolicy({
      owner,
      name: "ban-word",
      policyText:
        "Fail (verdict false) if the text field contains the substring BADWORD (case-sensitive). Otherwise pass.",
    });
    assertEquals("moderationPolicyId" in created, true);
    if (!("moderationPolicyId" in created)) return;
    const { moderationPolicyId } = created;

    const listed = await concept._listPoliciesForOwner({ owner });
    assertEquals(listed.moderationPolicyIds.includes(moderationPolicyId), true);

    const policy: ModerationPolicy = {
      moderationPolicyId,
      owner,
      name: "ban-word",
      policyText:
        "Fail (verdict false) if the text field contains the substring BADWORD (case-sensitive). Otherwise pass.",
    };

    const pass = await concept.moderate({
      policy,
      item: item1,
      content: { text: "Safe content." },
    });
    assertEquals("error" in pass, false);
    if ("error" in pass) return;
    assertEquals(typeof pass.verdict, "boolean");
    assertEquals(pass.verdict, true);

    const latestPass = await concept._getLatestModeration({ policy, item: item1 });
    assertExists(latestPass.moderationResult);
    assertEquals(latestPass.moderationResult?.status, "done");
    assertEquals(latestPass.moderationResult?.verdict, true);

    const fail = await concept.moderate({
      policy,
      item: item2,
      content: { text: "Contains BADWORD here." },
    });
    assertEquals("error" in fail, false);
    if ("error" in fail) return;
    assertEquals(fail.verdict, false);

    const flagged = await concept._getFlaggedItems({ policy });
    assertEquals(flagged.moderationResults.length >= 1, true);
    assertEquals(
      flagged.moderationResults.every((r) => r.verdict === false),
      true,
    );

    await concept.deleteModerationResult({
      moderationResultId: pass.moderationResultId,
    });
    const afterDel = await concept._getLatestModeration({ policy, item: item1 });
    assertEquals(afterDel.moderationResult, undefined);

    await concept.deleteAllModerationResultsForPolicy({ policy });
    const flaggedAfter = await concept._getFlaggedItems({ policy });
    assertEquals(flaggedAfter.moderationResults.length, 0);

    await concept.deletePolicy({ moderationPolicyId });
    const listedAfter = await concept._listPoliciesForOwner({ owner });
    assertEquals(listedAfter.moderationPolicyIds.includes(moderationPolicyId), false);
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIModeration: empty content object returns error",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIModerationConcept(db);
  try {
    const created = await concept.createPolicy({
      owner,
      name: "p",
      policyText: "Block nothing.",
    });
    assertEquals("moderationPolicyId" in created, true);
    if (!("moderationPolicyId" in created)) return;
    const { moderationPolicyId } = created;

    const policy: ModerationPolicy = {
      moderationPolicyId,
      owner,
      name: "p",
      policyText: "Block nothing.",
    };

    const res = await concept.moderate({
      policy,
      item: item1,
      content: {},
    });
    assertEquals("error" in res, true);

    const count = await db.collection("AIModeration.moderationResults").countDocuments({
      policyId: moderationPolicyId,
    });
    assertEquals(count, 0);

    await concept.deletePolicy({ moderationPolicyId });
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIModeration: deleteAllPoliciesForOwner",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIModerationConcept(db);
  try {
    const o = freshID() as Owner;
    const a = await concept.createPolicy({
      owner: o,
      name: "a",
      policyText: "A policy.",
    });
    const b = await concept.createPolicy({
      owner: o,
      name: "b",
      policyText: "B policy.",
    });
    assertEquals("moderationPolicyId" in a && "moderationPolicyId" in b, true);
    if (!("moderationPolicyId" in a) || !("moderationPolicyId" in b)) return;

    await concept.deleteAllPoliciesForOwner({ owner: o });
    const listed = await concept._listPoliciesForOwner({ owner: o });
    assertEquals(listed.moderationPolicyIds.length, 0);
  } finally {
    await client.close();
  }
});
