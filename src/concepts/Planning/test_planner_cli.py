import json
import os
import argparse
import sys
from datetime import datetime

# Import Planner directly
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dspy"))
from planner import Planner

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manual_test_schemas")

def save_schema(schema, project_id):
    """Saves the generated schema to a JSON file."""
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{project_id}_{timestamp}.json"
    filepath = os.path.join(OUTPUT_DIR, filename)
    
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2)
        
    print(f"\nSchema saved to: {filepath}")

def main():
    parser = argparse.ArgumentParser(description="Manual CLI for testing the Planning Agent")
    parser.add_argument("--id", type=str, default="test_project", help="Project ID")
    parser.add_argument("--desc", type=str, help="App description (optional, will prompt if missing)")
    
    args = parser.parse_args()
    
    print("--- Planning Agent Interactive Test ---")
    
    # 1. Get Description
    description = args.desc
    if not description:
        print("\nPlease enter a description for your app:")
        try:
            description = input("> ")
        except EOFError:
            print("Error: No input provided.")
            return
    
    if not description.strip():
        print("Description cannot be empty.")
        return

    # Initialize Planner
    print("\nInitializing Planner...")
    planner = Planner()

    # 2. Initial Request
    print(f"Analyzing request (this may take a moment)...")
    result = planner.generate_plan(description)

    # 3. Clarification Loop
    history = []
    
    while result.get("status") == "needs_clarification":
        print("\n" + "="*50)
        print("The agent needs clarification:")
        questions = result.get("questions", [])
        
        current_answers = {}
        for q in questions:
            print(f"\nQ: {q}")
            try:
                a = input("A: ")
            except EOFError:
                print("Error: Input stream closed.")
                return
            current_answers[q] = a
            
            # Add to local history tracker
            history.append({"question": q, "answer": a})
        
        # Pass history excluding current answers (agent combines them internally if logic matches)
        # Wait, the Planner.clarify_plan method takes (description, answers, previous_history).
        # We should verify that logic in planner.py.
        # Yes, clarify_plan(self, description, answers, previous_clarifications)
        
        previous_rounds_history = [h for h in history if h['question'] not in current_answers]
        
        print(f"\nSubmitting clarifications...")
        result = planner.clarify_plan(description, current_answers, previous_rounds_history)

    # 4. Final Result
    print("\n" + "="*50)
    print(f"Final Status: {result.get('status')}")
    
    if result.get("status") == "complete" and result.get("plan"):
        print("\nPlan generated successfully!")
        print(json.dumps(result["plan"], indent=2))
        save_schema(result["plan"], args.id)
    else:
        print("\nPlanning failed or ended with error.")
        print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
