import { assertEquals, assertExists } from "jsr:@std/assert";
import { freshID, testDb } from "@utils/database.ts";
import AIClassificationConcept, {
  Classifier,
  Item,
  Owner,
} from "./AIClassificationConcept.ts";

const owner = freshID() as Owner;
const item1 = freshID() as Item;
const item2 = freshID() as Item;

function allowedLabels() {
  return {
    cat: "feline",
    dog: "canine",
  } as Record<string, string>;
}

Deno.test({
  name: "AIClassification: create, classify, queries, and cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIClassificationConcept(db);
  try {
    const created = await concept.createClassifier({
      owner,
      name: "pets",
      labels: allowedLabels(),
      instructions: "Pick cat or dog based on the animal named.",
    });
    assertEquals("classifierId" in created, true);
    if (!("classifierId" in created)) return;
    const { classifierId } = created;

    const listed = await concept._listClassifiersForOwner({ owner });
    assertEquals(listed.classifierIds.includes(classifierId), true);

    const classifierDoc = await db.collection("AIClassification.classifiers").findOne({
      _id: classifierId,
    });
    assertExists(classifierDoc);

    const classifier: Classifier = {
      classifierId,
      owner,
      name: "pets",
      labels: allowedLabels(),
      instructions: "Pick cat or dog based on the animal named.",
    };

    const c1 = await concept.classify({
      classifier,
      item: item1,
      content: "Animal: domestic cat (Felis catus).",
    });
    assertEquals("error" in c1, false);
    if ("error" in c1) return;
    assertEquals(["cat", "dog"].includes(c1.label), true);

    const latest = await concept._getLatestClassification({
      classifier,
      item: item1,
    });
    assertExists(latest.classificationResult);
    assertEquals(latest.classificationResult?.status, "done");
    assertEquals(latest.classificationResult?.label, c1.label);
    assertEquals(latest.classificationResult?.item, item1);

    const byLabel = await concept._getItemsByLabel({
      classifier,
      label: c1.label,
    });
    assertEquals(byLabel.classificationResults.length >= 1, true);
    assertEquals(
      byLabel.classificationResults.every((r) => r.label === c1.label),
      true,
    );

    await concept.classify({
      classifier,
      item: item2,
      content: "Animal: domestic dog.",
    });

    const delOne = await concept.deleteClassificationResult({
      classificationResultId: c1.classificationResultId,
    });
    assertEquals(delOne, { ok: true });

    await concept.deleteAllClassificationResultsForClassifier({ classifier });
    const afterBulk = await concept._getLatestClassification({
      classifier,
      item: item2,
    });
    assertEquals(afterBulk.classificationResult, undefined);

    await concept.deleteClassifier({ classifierId });
    const listedAfter = await concept._listClassifiersForOwner({ owner });
    assertEquals(listedAfter.classifierIds.includes(classifierId), false);
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIClassification: updateClassifier changes labels",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIClassificationConcept(db);
  try {
    const created = await concept.createClassifier({
      owner,
      name: "t",
      labels: { x: "1", y: "2" },
    });
    assertEquals("classifierId" in created, true);
    if (!("classifierId" in created)) return;
    const { classifierId } = created;

    let classifier: Classifier = {
      classifierId,
      owner,
      name: "t",
      labels: { x: "1", y: "2" },
    };

    const up = await concept.updateClassifier({
      classifier,
      labels: { p: "a", q: "b" },
    });
    assertEquals(up, { ok: true });

    const refreshed = await db.collection("AIClassification.classifiers").findOne({
      _id: classifierId,
    });
    assertExists(refreshed);
    classifier = {
      classifierId,
      owner,
      name: "t",
      labels: refreshed!.labels as Record<string, unknown>,
    };

    const out = await concept.classify({
      classifier,
      item: item1,
      content: "Say p or q only; context: choose p.",
    });
    assertEquals("error" in out, false);
    if ("error" in out) return;
    assertEquals(["p", "q"].includes(out.label), true);

    await concept.deleteClassifier({ classifierId });
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIClassification: empty content returns error and no result row",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIClassificationConcept(db);
  try {
    const created = await concept.createClassifier({
      owner,
      name: "e",
      labels: { only: "one" },
    });
    assertEquals("classifierId" in created, true);
    if (!("classifierId" in created)) return;
    const { classifierId } = created;

    const classifier: Classifier = {
      classifierId,
      owner,
      name: "e",
      labels: { only: "one" },
    };

    const res = await concept.classify({
      classifier,
      item: item1,
      content: "   ",
    });
    assertEquals("error" in res, true);

    const count = await db.collection("AIClassification.classificationResults").countDocuments({
      classifierId,
    });
    assertEquals(count, 0);

    await concept.deleteClassifier({ classifierId });
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIClassification: deleteAllClassifiersForOwner",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIClassificationConcept(db);
  try {
    const o = freshID() as Owner;
    const a = await concept.createClassifier({
      owner: o,
      name: "a",
      labels: { l: "1" },
    });
    const b = await concept.createClassifier({
      owner: o,
      name: "b",
      labels: { l: "1" },
    });
    assertEquals("classifierId" in a && "classifierId" in b, true);
    if (!("classifierId" in a) || !("classifierId" in b)) return;

    await concept.deleteAllClassifiersForOwner({ owner: o });
    const listed = await concept._listClassifiersForOwner({ owner: o });
    assertEquals(listed.classifierIds.length, 0);
  } finally {
    await client.close();
  }
});
