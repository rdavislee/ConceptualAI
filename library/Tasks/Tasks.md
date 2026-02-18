**concept** Tasks [Assignee, Creator, Item]

**purpose**
To track units of work, their current status, and who is responsible for them.

**principle**
A creator defines a task with a title and description and assigns it to an assignee. The assignee updates the status as they work (e.g., from 'To Do' to 'Done'). When the work is no longer needed or completed, the task can be removed. Tasks can optionally have a due date or be associated with a specific item.

**state**
  a set of Tasks with
    an id (ID)
    a creator (Creator)
    an assignee (Assignee)
    an item (Item | null)
    a parent (Task | null)
    a title String
    a description String
    a status String ("To Do", "In Progress", "Done", "On Hold")
    a dueDate DateTime?
    a createdAt DateTime
    a updatedAt DateTime

**actions**

createTask (creator: Creator, assignee: Assignee, title: String, description: String, dueDate?: DateTime, item?: Item, parent?: Task) : (taskId: ID)
  **requires**
    title is not empty
  **effects**
    creates a new Task with status set to "To Do", and current timestamps

updateDetails (taskId: ID, title?: String, description?: String, dueDate?: DateTime) : (ok: Flag)
  **requires**
    task exists. If title provided, it must not be empty.
  **effects**
    updates the specified fields and sets updatedAt to now

updateStatus (taskId: ID, status: String) : (ok: Flag)
  **requires**
    task exists, status is one of ["To Do", "In Progress", "Done", "On Hold"]
  **effects**
    updates the task status and sets updatedAt to now

assign (taskId: ID, assignee: Assignee) : (ok: Flag)
  **requires**
    task exists
  **effects**
    updates the assignee of the task and sets updatedAt to now

deleteTask (taskId: ID) : (ok: Flag)
  **requires**
    task exists
  **effects**
    removes the task and recursively deletes all of its subtasks

deleteByCreator (creator: Creator) : (ok: Flag)
  **requires** true
  **effects** removes all tasks created by the given creator (for account deletion)

deleteByAssignee (assignee: Assignee) : (ok: Flag)
  **requires** true
  **effects** removes all tasks assigned to the given assignee (for account deletion)

deleteByItem (item: Item) : (ok: Flag)
  **requires** true
  **effects** removes all tasks associated with the given item (for item deletion)

deleteByParent (parent: Task) : (ok: Flag)
  **requires** true
  **effects** removes all direct subtasks of the given parent (used internally by cascade)

**queries**

_getTask (taskId: ID) : (task: Task?)
  **requires** true
  **effects** returns the task record if it exists

_getTasksByAssignee (assignee: Assignee) : (tasks: Set<Task>)
  **requires** true
  **effects** returns all tasks assigned to the user

_getTasksByCreator (creator: Creator) : (tasks: Set<Task>)
  **requires** true
  **effects** returns all tasks created by the user

_getTasksByItem (item: Item) : (tasks: Set<Task>)
  **requires** true
  **effects** returns all tasks associated with the given item

_getProjects () : (projects: Set<Task>)
  **requires** true
  **effects** returns all top-level tasks (no parent)

_getSubtasks (parent: Task) : (tasks: Set<Task>)
  **requires** true
  **effects** returns all subtasks for the given parent
