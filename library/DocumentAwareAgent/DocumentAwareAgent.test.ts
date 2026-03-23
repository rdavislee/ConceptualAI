import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import DocumentAwareAgentConcept, { Owner } from "./DocumentAwareAgentConcept.ts";

const owner = "owner:doc-agent-1" as Owner;

Deno.test({
  name: "DocumentAwareAgent: CRUD, capacity, AI answer and structured answer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const concept = new DocumentAwareAgentConcept(db);
    try {
      const created = await concept.createAgent({
        owner,
        name: "Notes",
        maxContextSize: 10_000,
        instructions: "Be terse.",
      });
      assertEquals("documentAwareAgentId" in created, true);
      if (!("documentAwareAgentId" in created)) return;
      const { documentAwareAgentId } = created;

      const add = await concept.addDocument({
        documentAwareAgentId,
        title: "A",
        content: "Fact one: project code is DA1.",
      });
      assertEquals("documentId" in add, true);

      const listed = await concept._listAgentsForOwner({ owner });
      assertEquals(listed.documentAwareAgentIds.includes(documentAwareAgentId as ID), true);

      const docIds = await concept._getDocuments({ documentAwareAgentId });
      assertEquals("documentIds" in docIds, true);
      if ("documentIds" in docIds) {
        assertEquals(docIds.documentIds.length >= 1, true);
      }

      const delDoc = await concept.deleteDocument({
        documentId: (add as { documentId: string }).documentId,
      });
      assertEquals(delDoc, { ok: true });

      await concept.deleteAgent({ documentAwareAgentId });
      const after = await concept._listAgentsForOwner({ owner });
      assertEquals(after.documentAwareAgentIds.includes(documentAwareAgentId as ID), false);

      const tiny = await concept.createAgent({
        owner,
        name: "Tiny",
        maxContextSize: 5,
      });
      assertEquals("documentAwareAgentId" in tiny, true);
      if (!("documentAwareAgentId" in tiny)) return;
      const tinyId = tiny.documentAwareAgentId;

      const block = await concept.addDocument({
        documentAwareAgentId: tinyId,
        title: "B",
        content: "abcde",
      });
      assertEquals("documentId" in block, true);

      const over = await concept.addDocument({
        documentAwareAgentId: tinyId,
        title: "C",
        content: "x",
      });
      assertEquals("error" in over, true);

      await concept.deleteAgent({ documentAwareAgentId: tinyId });

      const qa = await concept.createAgent({
        owner,
        name: "QA",
        maxContextSize: 2000,
      });
      assertEquals("documentAwareAgentId" in qa, true);
      if (!("documentAwareAgentId" in qa)) return;
      const qaId = qa.documentAwareAgentId;

      await concept.addDocument({
        documentAwareAgentId: qaId,
        title: "Spec",
        content: "PIN for demo vault is 4242.",
      });

      const out = await concept._answer({
        documentAwareAgentId: qaId,
        question: "What PIN is mentioned?",
      });
      assertEquals("answer" in out, true);
      if ("answer" in out) {
        assertExists(out.answer);
        assertEquals(out.answer.length > 0, true);
      }

      const st = await concept.createAgent({
        owner,
        name: "Struct",
        maxContextSize: 2000,
      });
      assertEquals("documentAwareAgentId" in st, true);
      if (!("documentAwareAgentId" in st)) return;
      const stId = st.documentAwareAgentId;

      await concept.addDocument({
        documentAwareAgentId: stId,
        title: "T",
        content: "Color: blue. Count: 3.",
      });

      const schema = {
        type: "object",
        properties: {
          color: { type: "string" },
          count: { type: "number" },
        },
        required: ["color", "count"],
      } as const;

      const structured = await concept._answerStructured({
        documentAwareAgentId: stId,
        question: "Extract color and count.",
        schema: schema as Record<string, unknown>,
      });

      assertEquals("answerJson" in structured, true);
      if ("answerJson" in structured) {
        const j = structured.answerJson;
        assertEquals(typeof j.color === "string" && (j.color as string).length > 0, true);
        assertEquals(typeof j.count === "number", true);
      }

      await concept.deleteAllAgentsForOwner({ owner });
    } finally {
      await client.close();
    }
  },
});
