import json
import os
import argparse
import sys
from datetime import datetime

# Import ConceptDesigner directly
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dspy"))
from designer import ConceptDesigner

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manual_test_schemas")

def save_design(design, project_id):
    """Saves the generated design to a JSON file."""
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{project_id}_design_{timestamp}.json"
    filepath = os.path.join(OUTPUT_DIR, filename)
    
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(design, f, indent=2)
        
    print(f"\nDesign saved to: {filepath}")

def load_plan(plan_path):
    """Loads a plan from a JSON file."""
    try:
        with open(plan_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading plan: {e}")
        return None

def main():
    parser = argparse.ArgumentParser(description="Manual CLI for testing the Concept Designing Agent")
    parser.add_argument("--id", type=str, default="test_project", help="Project ID")
    parser.add_argument("--plan", type=str, help="Path to JSON plan file (required)")
    parser.add_argument("--concepts", type=str, help="Path to available concepts markdown (optional, uses default mock if missing)")
    
    args = parser.parse_args()
    
    print("--- Concept Designing Agent Interactive Test ---")
    
    # 1. Load Plan
    if not args.plan:
        print("\nPlease provide a plan JSON file using --plan <path>")
        return

    plan = load_plan(args.plan)
    if not plan:
        return
    
    # 2. Load Available Concepts
    if args.concepts:
        try:
            with open(args.concepts, "r", encoding="utf-8") as f:
                available_concepts = f.read()
        except Exception as e:
            print(f"Error loading concepts file: {e}")
            return
    else:
        print("\nUsing default mock available concepts...")
        available_concepts = """
### Concept: UserAuthenticating [User]
**purpose** identify users
**state** users set of User with username, password
**actions** register, login

### Concept: Sessioning [User]
**purpose** manage user sessions
**state** sessions set of Session with user, token
**actions** start, end

### Concept: Liking [User, Item]
**purpose** allow users to like items
**state** likes set of Like with user, item
**actions** like, unlike
"""

    # Initialize Designer
    print("\nInitializing ConceptDesigner...")
    designer = ConceptDesigner()

    # 3. Generate Design
    print(f"Generating design (this may take a moment)...")
    
    # Plan needs to be passed as string to the designer method
    plan_str = json.dumps(plan, indent=2)
    
    result = designer.generate_design(plan_str, available_concepts)

    # 4. Final Result
    print("\n" + "="*50)
    
    if result.get("error"):
         print(f"Design generation failed: {result.get('error')}")
    else:
        print("\nDesign generated successfully!")
        print(json.dumps(result, indent=2))
        save_design(result, args.id)

if __name__ == "__main__":
    main()

