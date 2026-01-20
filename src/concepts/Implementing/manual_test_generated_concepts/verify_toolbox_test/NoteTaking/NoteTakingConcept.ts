import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

const PREFIX = "NoteTaking.";

type Author = ID;
type Note = ID;

interface NoteDoc {
  _id: Note;
  author: Author;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * @concept NoteTaking [Author]
 * @purpose allow authors to capture and preserve information for later reference
 * @principle if an author creates a note with specific content, that content is stored and can be retrieved or modified by the author at a later time.
 */
export default class NoteTakingConcept {
  notes: Collection<NoteDoc>;

  constructor(private readonly db: Db) {
    this.notes = this.db.collection(PREFIX + "notes");
    this.notes.createIndex({ author: 1 });
  }

  /**
   * create (author: Author, title: String, content: String): (note: Note)
   *
   * **requires** true
   * **effects** create note, set note.author to author, set note.title to title, set note.content to content, set note.createdAt to current time, set note.updatedAt to current time
   */
  async create(
    { author, title, content }: {
      author: Author;
      title: string;
      content: string;
    },
  ): Promise<{ note: Note }> {
    const now = Date.now();
    const note: NoteDoc = {
      _id: freshID(),
      author,
      title,
      content,
      createdAt: now,
      updatedAt: now,
    };
    await this.notes.insertOne(note);
    return { note: note._id };
  }

  /**
   * update (note: Note, title: String, content: String)
   *
   * **requires** note exists
   * **effects** set note.title to title, set note.content to content, set note.updatedAt to current time
   */
  async update(
    { note, title, content }: { note: Note; title: string; content: string },
  ): Promise<Record<string, never> | { error: string }> {
    const result = await this.notes.updateOne(
      { _id: note },
      {
        $set: {
          title,
          content,
          updatedAt: Date.now(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return { error: "Note not found" };
    }

    return {};
  }

  /**
   * delete (note: Note)
   *
   * **requires** note exists
   * **effects** delete note
   */
  async delete(
    { note }: { note: Note },
  ): Promise<Record<string, never> | { error: string }> {
    const result = await this.notes.deleteOne({ _id: note });

    if (result.deletedCount === 0) {
      return { error: "Note not found" };
    }

    return {};
  }

  /**
   * getNotes (author: Author): (notes: Set<Note>)
   *
   * **requires** author exists
   * **effects** return notes where note.author is author
   */
  async _getNotes(
    { author }: { author: Author },
  ): Promise<{ notes: Note[] }[]> {
    const docs = await this.notes.find({ author }).toArray();
    const notes = docs.map((d) => d._id);
    return [{ notes }];
  }

  /**
   * getNote (note: Note): (title: String, content: String, createdAt: Number, updatedAt: Number)
   *
   * **requires** note exists
   * **effects** return note.title, note.content, note.createdAt, note.updatedAt
   */
  async _getNote(
    { note }: { note: Note },
  ): Promise<
    { title: string; content: string; createdAt: number; updatedAt: number }[]
  > {
    const doc = await this.notes.findOne({ _id: note });
    if (!doc) {
      return [];
    }
    return [{
      title: doc.title,
      content: doc.content,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }];
  }
}