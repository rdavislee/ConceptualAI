**concept** AIConversation [User]

**purpose**
support conversational AI interactions with persistent threads whose stored history grows with each user-assistant exchange

**principle**
if a conversation is opened and a participant sends a message, then the system stores that message, generates the assistant's string reply, and adds it to the same conversation so the full exchange can be retrieved later

**state**
  a set of Conversations with
    a conversationId ID
    an owner User
    a systemPrompt? String
    a status String
    a messages List of Objects { role: String, content: String }

**actions**

createConversation (owner: User, systemPrompt?: String) : (conversationId: ID)
  **requires** true
  **effects**
    creates a new conversation with a fresh conversationId, status "idle", messages := []

setSystemPrompt (conversationId: ID, systemPrompt: String) : (ok: Flag)
  **requires**
    there exists a conversation whose conversationId is conversationId
  **effects**
    sets systemPrompt of that conversation to systemPrompt

sendMessage (conversationId: ID, role: String, content: String, instructions?: String, context?: Object) : (reply?: String, error?: String)
  **requires**
    there exists a conversation whose conversationId is conversationId
    status of that conversation is "idle"
    role is not empty
    content is not empty
  **effects**
    sets status of that conversation to "thinking"
    appends a message with role := role and content := content to messages of that conversation
    if AI reply generation succeeds, appends an assistant message with role "assistant" and content := reply to messages of that conversation
    if AI reply generation fails, returns error and does not append an assistant message
    sets status of that conversation to "idle"

deleteConversation (conversationId: ID) : (ok: Flag)
  **requires**
    there exists a conversation whose conversationId is conversationId
  **effects**
    deletes that conversation

deleteAllConversationsForOwner (owner: User) : (ok: Flag)
  **requires** true
  **effects**
    deletes all conversations whose owner is owner

**queries**

_getConversation (conversationId: ID) : (conversation: Conversation)
  **requires**
    there exists a conversation whose conversationId is conversationId
  **effects**
    returns that conversation

_listConversationsForOwner (owner: User) : (conversationIds: set of ID)
  **requires** true
  **effects**
    returns the set of conversationIDs for all conversations owned by owner
