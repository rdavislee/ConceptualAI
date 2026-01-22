import sys
import os
import json
from dotenv import load_dotenv

# Load env vars first to get HEADLESS_URL
load_dotenv()

# Ensure we can import implementer
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from implementer import ImplementerModule

def test_storying_generation():
    print("Testing Storying generation with REAL RAG...")
    print(f"Using HEADLESS_URL: {os.getenv('HEADLESS_URL')}")

    # Initialize implementer
    try:
        print("Initializing ImplementerModule...")
        implementer = ImplementerModule()
    except Exception as e:
        print(f"Failed to initialize ImplementerModule: {e}")
        return

    # Verify it fetched specs
    print(f"Library Specs Loaded: {len(implementer.library_specs)}")
    # We don't assert Posting is here, but we hope it is.
    if "Posting" in implementer.library_specs:
        print("Confirmed: 'Posting' is in the library specs.")
    else:
        print("WARNING: 'Posting' was NOT found in the library specs. RAG might not work as expected.")

    # Define Storying Spec
    storying_spec = """
### Concept: Storying [Author, Story]

**purpose**
Allows authors to create short-lived stories that expire after a set time.

**principle**
A story is created by an author and is automatically deleted after its expiration time.

**state (SSF)**
a set of Stories with
  a story ID
  an author ID
  a content Object
  a type? String
  a createdAt DateTime
  a expiresAt DateTime

**actions**

* **createStory (author: authorID, content: Object, durationSeconds: Number, type?: String) : (story: storyID)**
  requires: content is not empty, durationSeconds > 0
  effects: create story with createdAt := now, expiresAt := now + durationSeconds

* **deleteStory (story: storyID, author: authorID) : (ok: Flag)**
  requires: story exists, author of story is authorID
  effects: delete the story

* **checkExpirations () : (count: Number)**
  effects: delete all stories where expiresAt < now

**queries**
`_getStoriesByAuthor(author: authorID) : (stories: Set<Story>)`
`_activeStories() : (stories: Set<Story>)`
"""

    print("Running implementer (this may take 30-60s)...")
    try:
        result = implementer.implement(storying_spec, "Storying")
    except Exception as e:
        print(f"Exception during implementation: {e}")
        import traceback
        traceback.print_exc()
        return

    if result.get("status") == "complete":
        print("SUCCESS: Storying implemented.")
        print("Code Preview:")
        print(result["code"][:500])
        print("\nTests Preview:")
        print(result["tests"][:200])
        print(f"\nIterations: {result.get('iterations')}")
        
        # Save files to 'storying' directory
        output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storying")
        os.makedirs(output_dir, exist_ok=True)
        
        with open(os.path.join(output_dir, "StoryingConcept.ts"), "w", encoding="utf-8") as f:
            f.write(result["code"])
            
        with open(os.path.join(output_dir, "StoryingConcept.test.ts"), "w", encoding="utf-8") as f:
            f.write(result["tests"])
            
        print(f"Files saved to {output_dir}")
        
    else:
        print("FAILURE: Implementation failed.")
        print(f"Error Log: {result.get('error_log')}")
        print(f"Iterations: {result.get('iterations')}")

if __name__ == "__main__":
    test_storying_generation()
