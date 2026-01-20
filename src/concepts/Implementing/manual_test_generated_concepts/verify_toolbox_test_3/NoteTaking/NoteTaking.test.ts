import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import NoteTakingConcept from "./NoteTakingConcept.ts";

const authorA = "author:Alice" as ID;
const authorB = "author:Bob" as ID;

Deno.test("Principle: author creates, retrieves, updates, and deletes a note", async () => {
  const [db, client] = await testDb();
  const notes = new NoteTakingConcept(db);
  try {
    console.log("Testing principle: create -> retrieve -> update -> delete flow");

    // 1. Create a note
    const title1 = "Meeting Notes";
    const content1 = "Discuss project roadmap.";
    console.log(`Creating note for ${authorA}: "${title1}"`);
    const createResult = await notes.create({
      author: authorA,
      title: title1,
      content: content1,
    });
    const noteId = createResult.note;
    assertExists(noteId, "Create should return a note ID");

    // 2. Retrieve the note to verify storage
    console.log(`Retrieving note: ${noteId}`);
    const getResult = await notes._getNote({ note: noteId });
    assertEquals(getResult.length, 1, "Should find exactly one note");
    assertEquals(getResult[0].title, title1, "Title should match");
    assertEquals(getResult[0].content, content1, "Content should match");
    const initialUpdatedAt = getResult[0].updatedAt;

    // 3. Update the note
    const title2 = "Meeting Notes (Revised)";
    const content2 = "Discuss project roadmap and budget.";
    console.log(`Updating note: ${noteId}`);
    // Small delay to ensure timestamp difference if system is too fast
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updateResult = await notes.update({
      note: noteId,
      title: title2,
      content: content2,
    });
    assertEquals(
      "error" in updateResult,
      false,
      "Update should succeed without error",
    );

    // 4. Retrieve again to verify modification
    console.log(`Retrieving note after update: ${noteId}`);
    const getResult2 = await notes._getNote({ note: noteId });
    assertEquals(getResult2[0].title, title2, "Updated title should match");
    assertEquals(getResult2[0].content, content2, "Updated content should match");
    assertNotEquals(
      getResult2[0].updatedAt,
      initialUpdatedAt,
      "updatedAt should have changed",
    );

    // 5. Delete the note
    console.log(`Deleting note: ${noteId}`);
    const deleteResult = await notes.delete({ note: noteId });
    assertEquals(
      "error" in deleteResult,
      false,
      "Delete should succeed without error",
    );

    // 6. Verify deletion
    console.log(`Verifying deletion of note: ${noteId}`);
    const getResult3 = await notes._getNote({ note: noteId });
    assertEquals(getResult3.length, 0, "Note should no longer exist");

    console.log("Principle trace complete.");
  } finally {
    await client.close();
  }
});

Deno.test("Action: create sets timestamps and associates author", async () => {
  const [db, client] = await testDb();
  const notes = new NoteTakingConcept(db);
  try {
    const start = Date.now();
    const { note: noteId } = await notes.create({
      author: authorA,
      title: "Test",
      content: "Content",
    });

    const result = await notes._getNote({ note: noteId });
    const noteData = result[0];

    // Check timestamps
    assertExists(noteData.createdAt, "createdAt should exist");
    assertExists(noteData.updatedAt, "updatedAt should exist");
    assertEquals(
      noteData.createdAt >= start,
      true,
      "createdAt should be recent",
    );
    assertEquals(
      noteData.updatedAt,
      noteData.createdAt,
      "createdAt and updatedAt should be equal on creation",
    );

    // Check author association via getNotes
    const authorNotes = await notes._getNotes({ author: authorA });
    assertEquals(
      authorNotes[0].notes.includes(noteId),
      true,
      "Note should be associated with the author",
    );
  } finally {
    await client.close();
  }
});

Deno.test("Action: update requires note exists", async () => {
  const [db, client] = await testDb();
  const notes = new NoteTakingConcept(db);
  try {
    const nonExistentNote = "note:fake" as ID;
    const result = await notes.update({
      note: nonExistentNote,
      title: "New Title",
      content: "New Content",
    });

    assertEquals("error" in result, true, "Should return error for missing note");
    if ("error" in result) {
      assertEquals(result.error, "Note not found");
    }
  } finally {
    await client.close();
  }
});

Deno.test("Action: delete requires note exists", async () => {
  const [db, client] = await testDb();
  const notes = new NoteTakingConcept(db);
  try {
    const nonExistentNote = "note:fake" as ID;
    const result = await notes.delete({ note: nonExistentNote });

    assertEquals("error" in result, true, "Should return error for missing note");
    if ("error" in result) {
      assertEquals(result.error, "Note not found");
    }
  } finally {
    await client.close();
  }
});

Deno.test("Query: getNotes filters by author", async () => {
  const [db, client] = await testDb();
  const notes = new NoteTakingConcept(db);
  try {
    // Create 2 notes for Author A
    const { note: noteA1 } = await notes.create({
      author: authorA,
      title: "A1",
      content: "C1",
    });
    const { note: noteA2 } = await notes.create({
      author: authorA,
      title: "A2",
      content: "C2",
    });

    // Create 1 note for Author B
    const { note: noteB1 } = await notes.create({
      author: authorB,
      title: "B1",
      content: "C3",
    });

    // Query Author A
    const resultA = await notes._getNotes({ author: authorA });
    const listA = resultA[0].notes;
    assertEquals(listA.length, 2, "Author A should have 2 notes");
    assertEquals(listA.includes(noteA1), true);
    assertEquals(listA.includes(noteA2), true);
    assertEquals(listA.includes(noteB1), false);

    // Query Author B
    const resultB = await notes._getNotes({ author: authorB });
    const listB = resultB[0].notes;
    assertEquals(listB.length, 1, "Author B should have 1 note");
    assertEquals(listB.includes(noteB1), true);

    // Query Author C (no notes)
    const authorC = "author:Charlie" as ID;
    const resultC = await notes._getNotes({ author: authorC });
    assertEquals(resultC[0].notes.length, 0, "Author C should have 0 notes");
  } finally {
    await client.close();
  }
});