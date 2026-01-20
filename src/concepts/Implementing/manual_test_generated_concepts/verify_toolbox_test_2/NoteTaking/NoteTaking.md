**concept** NoteTaking [Author]

**purpose** allow authors to capture and preserve information for later reference

**principle** if an author creates a note with specific content, that content is stored and can be retrieved or modified by the author at a later time.

**state**
notes set of Note
  author Author
  title String
  content String
  createdAt Number
  updatedAt Number

**actions**
create (author: Author, title: String, content: String): (note: Note)
  **requires** true
  **effects** create note, set note.author to author, set note.title to title, set note.content to content, set note.createdAt to current time, set note.updatedAt to current time

update (note: Note, title: String, content: String)
  **requires** note exists
  **effects** set note.title to title, set note.content to content, set note.updatedAt to current time

delete (note: Note)
  **requires** note exists
  **effects** delete note

**queries**
getNotes (author: Author): (notes: Set<Note>)
  **requires** author exists
  **effects** return notes where note.author is author

getNote (note: Note): (title: String, content: String, createdAt: Number, updatedAt: Number)
  **requires** note exists
  **effects** return note.title, note.content, note.createdAt, note.updatedAt