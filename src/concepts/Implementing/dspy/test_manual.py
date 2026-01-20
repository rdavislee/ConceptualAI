import json
import subprocess
import os

spec = """
### Concept: TodoList [User, Item]

**purpose**
Manage a list of items for users.

**principle**
Users can add, remove, and complete items.

**state (SSF)**
a set of Items with
  an item ID
  an owner (User)
  a content String
  a isComplete Boolean

**actions**

* **add (owner: User, content: String) : (item: Item)**
  requires: content is not empty
  effects: creates new item with isComplete=false

* **complete (item: Item) : (ok: Boolean)**
  requires: item exists
  effects: sets isComplete=true

* **remove (item: Item) : (ok: Boolean)**
  requires: item exists
  effects: deletes item

**queries**
`_getItems(owner: User) : (items: Set<Item>)`
"""

payload = {
    "action": "implement",
    "payload": {
        "spec": spec,
        "conceptName": "TodoList"
    }
}

input_json = json.dumps(payload)

# Run the main.py script
process = subprocess.Popen(
    ["python", "src/concepts/Implementing/dspy/main.py"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    env={**os.environ, "GEMINI_MODEL": "gemini-2.0-flash-exp"} # Use flash for speed
)

stdout, stderr = process.communicate(input=input_json)

if stderr:
    print("STDERR:", stderr)

try:
    result = json.loads(stdout)
    if result.get("status") == "complete":
        print("SUCCESS! Implementation generated.")
        print("Iterations:", result.get("iterations"))
        # print("Code Preview:", result.get("code")[:200])
    else:
        print("FAILURE:", result)
except json.JSONDecodeError:
    print("Invalid JSON output:", stdout)
