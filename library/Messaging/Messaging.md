**concept** Messaging [User, Message]

**purpose**
Allows users to send messages to other users or groups, supporting various formats and metadata.

**principle**
If a user sends a message to a recipient, then the message is stored and can be retrieved by either party; if the sender later edits the message, the previous versions are preserved in a history.

**state**
  a set of Messages with
    a message ID
    a sender (User)
    a recipient (User)
    a content Object    -- must be a JSON object (not a string/array/null)
    a type? String (e.g., "text", "image", "system")
    a metadata? Object
    a createdAt DateTime
    an updatedAt DateTime
    an edits List of Objects { content: Object, timestamp: DateTime }

**content format**
The `content` field must be a JSON object with at least one property that has a defined value. Raw strings are not accepted.

Examples:
- Text message: `{ text: "Hello!" }`
- Image message: `{ imageUrl: "https://...", caption: "Photo" }`
- Rich message: `{ text: "Check this out", link: "https://...", preview: { title: "..." } }`

**actions**

sendMessage (sender: User, recipient: User, content: Object, type?: String, metadata?: Object) : (messageId: Message)
  **requires**
    content is a non-empty object with at least one defined value
  **effects**
    create message with createdAt := now, updatedAt := now, edits := []

editMessage (messageId: Message, sender: User, content: Object) : (ok: Flag)
  **requires**
    message exists, sender of message is sender, content is a non-empty object with at least one defined value
  **effects**
    add current content to edits list, update content to new content, set updatedAt := now

deleteMessage (messageId: Message, sender: User) : (ok: Flag)
  **requires**
    message exists, sender of message is sender
  **effects**
    delete the message

deleteBySender (sender: User) : (ok: Flag)
  **requires** true
  **effects** remove all messages sent by sender (for account deletion)

deleteByRecipient (recipient: User) : (ok: Flag)
  **requires** true
  **effects** remove all messages received by recipient (for account deletion)

**queries**

_getMessagesBetween (userA: User, userB: User, limit?: Number, skip?: Number) : (messages: Set<Message>)
  **requires** true
  **effects** returns messages exchanged between userA and userB, oldest first; optional limit/skip for pagination

_getRecentMessagesForUser (user: User, limit?: Number, skip?: Number) : (messages: Set<Message>)
  **requires** true
  **effects** returns messages where user is sender or recipient, latest first; optional limit/skip for pagination

_getMessagesForRecipient (recipient: User, limit?: Number, skip?: Number) : (messages: Set<Message>)
  **requires** true
  **effects** returns messages sent to recipient, latest first; optional limit/skip for pagination

_getConversationPartners (user: User) : (partners: Set<User>)
  **requires** true
  **effects** returns IDs of all users this user has messaged or received messages from
