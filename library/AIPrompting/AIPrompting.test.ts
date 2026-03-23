import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import AIPromptingConcept, { Owner } from "./AIPromptingConcept.ts";

const owner = "user:PromptOwner" as Owner;
const tinyNumberSchema = {
  type: "object",
  properties: {
    n: { type: "number" },
  },
  required: ["n"],
} as const;

Deno.test({
  name: "runTextPrompt persists done run with non-empty outputText",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const prompting = new AIPromptingConcept(db);
    try {
      const res = await prompting.runTextPrompt({
        owner,
        userPrompt: "Reply with one word: hello",
        systemPrompt: "Output plain text only.",
      });
      assertEquals("promptRunId" in res, true);
      const { promptRunId, outputText, error } = res as {
        promptRunId: string;
        outputText?: string;
        error?: string;
      };
      assertExists(promptRunId);
      assertEquals(error == null || error === "", true);
      assertExists(outputText);
      assertEquals(outputText!.trim().length > 0, true);

      const got = await prompting._getRun({ promptRunId });
      assertEquals(got.length, 1);
      assertEquals(got[0].promptRun.status, "done");
      assertEquals(got[0].promptRun.outputText?.trim().length! > 0, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "runStructuredPrompt returns schema-shaped outputJson",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const prompting = new AIPromptingConcept(db);
    try {
      const res = await prompting.runStructuredPrompt({
        owner,
        userPrompt: "Return JSON with n equal to 7.",
        schema: { ...tinyNumberSchema },
        systemPrompt: "Follow the schema exactly.",
      });
      assertEquals("promptRunId" in res, true);
      const { promptRunId, outputJson, error } = res as {
        promptRunId: string;
        outputJson?: Record<string, unknown>;
        error?: string;
      };
      assertExists(promptRunId);
      assertEquals(error == null || error === "", true);
      assertExists(outputJson);
      assertEquals(typeof outputJson!.n, "number");

      const got = await prompting._getRun({ promptRunId });
      assertEquals(got[0].promptRun.status, "done");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Validation: empty userPrompt and empty schema",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const prompting = new AIPromptingConcept(db);
    try {
      const t = await prompting.runTextPrompt({ owner, userPrompt: "   " });
      assertEquals("error" in t, true);
      assertEquals("promptRunId" in t, false);

      const s = await prompting.runStructuredPrompt({
        owner,
        userPrompt: "x",
        schema: {},
      });
      assertEquals("error" in s, true);
      assertEquals("promptRunId" in s, false);

      const su = await prompting.runStructuredPrompt({
        owner,
        userPrompt: "",
        schema: { ...tinyNumberSchema },
      });
      assertEquals("error" in su, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "_getLatestSuccessfulRun returns most recent successful run",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const prompting = new AIPromptingConcept(db);
    try {
      const first = await prompting.runTextPrompt({
        owner,
        userPrompt: "Say: a",
      });
      const pid1 = (first as { promptRunId: string }).promptRunId;
      const second = await prompting.runTextPrompt({
        owner,
        userPrompt: "Say: b",
      });
      const pid2 = (second as { promptRunId: string }).promptRunId;

      const latest = await prompting._getLatestSuccessfulRun({ owner });
      assertEquals(latest.length, 1);
      assertEquals(latest[0].promptRunId, pid2);

      const listed = await prompting._listRunsForOwner({ owner });
      assertEquals(listed[0].promptRunIds.includes(pid1 as ID), true);
      assertEquals(listed[0].promptRunIds.includes(pid2 as ID), true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "_getLatestSuccessfulRun empty when no successful runs",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const prompting = new AIPromptingConcept(db);
    const other = "user:PromptOwnerOther" as Owner;
    try {
      await prompting.runs.insertOne({
        _id: "00000000-0000-4000-8000-000000000002" as Owner,
        owner: other,
        userPrompt: "x",
        status: "done",
        error: "failed",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const latest = await prompting._getLatestSuccessfulRun({ owner: other });
      assertEquals(latest.length, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "deleteRun and deleteAllRunsForOwner",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const prompting = new AIPromptingConcept(db);
    try {
      const r = await prompting.runTextPrompt({
        owner,
        userPrompt: "Say hi",
      });
      const id = (r as { promptRunId: string }).promptRunId;
      const del = await prompting.deleteRun({ promptRunId: id });
      assertEquals("ok" in del, true);

      await prompting.runTextPrompt({ owner, userPrompt: "x" });
      await prompting.deleteAllRunsForOwner({ owner });
      const listed = await prompting._listRunsForOwner({ owner });
      assertEquals(listed[0].promptRunIds.length, 0);

      const bad = await prompting.deleteRun({ promptRunId: id });
      assertEquals("error" in bad, true);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Query _getRun empty when missing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const prompting = new AIPromptingConcept(db);
    try {
      const got = await prompting._getRun({
        promptRunId: "00000000-0000-4000-8000-000000000000",
      });
      assertEquals(got.length, 0);
    } finally {
      await client.close();
    }
  },
});
