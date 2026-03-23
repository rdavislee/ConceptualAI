import { assertEquals, assertExists } from "jsr:@std/assert";
import { freshID, testDb } from "@utils/database.ts";
import AIExtractionConcept, { Extractor, Owner } from "./AIExtractionConcept.ts";

const owner = freshID() as Owner;

const simpleSchema = {
  type: "object",
  properties: {
    answer: { type: "string", enum: ["yes", "no"] },
  },
  required: ["answer"],
  additionalProperties: false,
} as Record<string, unknown>;

Deno.test({
  name: "AIExtraction: extract persists schema-shaped output and status",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIExtractionConcept(db);
  try {
    const created = await concept.createExtractor({
      owner,
      name: "yn",
      schema: simpleSchema,
      instructions: 'Answer "yes" or "no" only in the answer field.',
    });
    assertEquals("extractorId" in created, true);
    if (!("extractorId" in created)) return;
    const { extractorId } = created;

    const ex: Extractor = {
      extractorId,
      owner,
      name: "yn",
      schema: simpleSchema,
      instructions: 'Answer "yes" or "no" only in the answer field.',
      status: "idle",
      input: "",
    };

    const out = await concept.extract({
      extractor: ex,
      content: "Is ice cold? Respond yes.",
    });
    assertEquals("error" in out, false);
    if ("error" in out) return;

    assertExists(out.outputJson);
    assertEquals(out.outputJson?.answer === "yes" || out.outputJson?.answer === "no", true);

    const got = await concept._getExtractor({ extractorId });
    assertEquals("error" in got, false);
    if ("error" in got) return;
    assertEquals(got.extractor.status, "done");
    assertEquals(got.extractor.input.length > 0, true);
    assertExists(got.extractor.outputJson);
    assertEquals(got.extractor.error, undefined);

    await concept.deleteExtractor({ extractorId });
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIExtraction: list and deleteAllExtractorsForOwner",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIExtractionConcept(db);
  try {
    const o = freshID() as Owner;
    const a = await concept.createExtractor({
      owner: o,
      name: "a",
      schema: simpleSchema,
    });
    const b = await concept.createExtractor({
      owner: o,
      name: "b",
      schema: simpleSchema,
    });
    assertEquals("extractorId" in a && "extractorId" in b, true);
    if (!("extractorId" in a) || !("extractorId" in b)) return;

    const listed = await concept._listExtractorsForOwner({ owner: o });
    assertEquals(listed.extractorIds.length, 2);

    await concept.deleteAllExtractorsForOwner({ owner: o });
    const after = await concept._listExtractorsForOwner({ owner: o });
    assertEquals(after.extractorIds.length, 0);
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIExtraction: empty content returns error",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIExtractionConcept(db);
  try {
    const created = await concept.createExtractor({
      owner,
      name: "empty",
      schema: simpleSchema,
    });
    assertEquals("extractorId" in created, true);
    if (!("extractorId" in created)) return;
    const { extractorId } = created;

    const ex: Extractor = {
      extractorId,
      owner,
      name: "empty",
      schema: simpleSchema,
      status: "idle",
      input: "",
    };

    const res = await concept.extract({ extractor: ex, content: "" });
    assertEquals("error" in res, true);

    await concept.deleteExtractor({ extractorId });
  } finally {
    await client.close();
  }
});

Deno.test({
  name: "AIExtraction: _getExtractor missing id",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const [db, client] = await testDb();
  const concept = new AIExtractionConcept(db);
  try {
    const res = await concept._getExtractor({ extractorId: freshID() });
    assertEquals("error" in res, true);
  } finally {
    await client.close();
  }
});
