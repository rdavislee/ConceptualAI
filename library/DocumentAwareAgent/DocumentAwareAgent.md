**concept** DocumentAwareAgent [Owner]

**purpose**
support AI agent interactions over a bounded set of in-context documents without requiring full retrieval infrastructure

**principle**
if a user creates a document-aware agent, adds documents to it while capacity remains, and then asks a question, the agent answers using its currently held document context; if the user tries to add more document content than the agent can hold, the addition is rejected

**state**
  a set of DocumentAwareAgents with
    a documentAwareAgentId ID
    an owner Owner
    a name String
    an instructions? String
    a maxContextSize Number

  a set of Documents with
    an agent DocumentAwareAgent
    a documentId ID
    a title String
    a content String
    a metadata? Object

**actions**

createAgent (owner: Owner, name: String, maxContextSize: Number, instructions?: String) : (documentAwareAgentId: ID)
  **requires**
    name is not empty
    maxContextSize > 0
  **effects**
    creates a new document-aware agent with a fresh documentAwareAgentId

renameAgent (documentAwareAgentId: ID, name: String) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    name is not empty
  **effects**
    sets name of that document-aware agent to name

updateInstructions (documentAwareAgentId: ID, instructions: String) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    sets instructions of that document-aware agent to instructions

addDocument (documentAwareAgentId: ID, title: String, content: String, metadata?: Object) : (documentId?: ID, error?: String)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    title is not empty
    content is not empty
  **effects**
    if adding the document would keep the total held document context within maxContextSize, creates a new document with a fresh documentId
    if adding the document would exceed maxContextSize, returns error and does not add the document

deleteDocument (documentId: ID) : (ok: Flag)
  **requires**
    there exists a document whose documentId is documentId
  **effects**
    deletes that document

deleteAllDocuments (documentAwareAgentId: ID) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    deletes all documents associated with that document-aware agent

deleteAgent (documentAwareAgentId: ID) : (ok: Flag)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    deletes that document-aware agent and all documents associated with it

deleteAllAgentsForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all document-aware agents whose owner is owner and all documents associated with them

**queries**

_listAgentsForOwner (owner: Owner) : (documentAwareAgentIds: set of ID)
  **requires** true
  **effects**
    returns the set of documentAwareAgentId values for all document-aware agents owned by owner

_getDocuments (documentAwareAgentId: ID) : (documentIds: set of ID)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
  **effects**
    returns the set of documentId values for all documents associated with that document-aware agent

_answer (documentAwareAgentId: ID, question: String) : (answer: String)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    question is not empty
  **effects**
    returns an answer generated using the documents currently held by that document-aware agent

_answerStructured (documentAwareAgentId: ID, question: String, schema: Object) : (answerJson: Object)
  **requires**
    there exists a document-aware agent whose documentAwareAgentId is documentAwareAgentId
    question is not empty
    schema is not empty
  **effects**
    returns a structured answer matching schema using the documents currently held by that document-aware agent
