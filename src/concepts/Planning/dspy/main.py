import sys
import json
import os
from planner import Planner

def main():
    # Read from stdin
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"error": "No input provided"}))
            return

        request = json.loads(input_data)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {str(e)}"}))
        return

    action = request.get("action")
    payload = request.get("payload", {})

    planner = Planner()

    try:
        if action == "initiate":
            description = payload.get("description")
            if not description:
                print(json.dumps({"error": "Missing description"}))
                return
            
            result = planner.generate_plan(description)
            print(json.dumps(result))

        elif action == "clarify":
            original_description = payload.get("original_description")
            answers = payload.get("answers")
            previous_clarifications = payload.get("previous_clarifications", [])
            
            if not original_description or answers is None:
                print(json.dumps({"error": "Missing required fields for clarify"}))
                return

            result = planner.clarify_plan(original_description, answers, previous_clarifications)
            print(json.dumps(result))

        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))

    except Exception as e:
        print(json.dumps({"error": f"Internal planner error: {str(e)}"}))

if __name__ == "__main__":
    main()
