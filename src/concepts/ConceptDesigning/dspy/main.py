import sys
import json
from designer import ConceptDesigner

def main():
    # Read from stdin
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"error": "No input provided"}))
            return

        request = json.loads(input_data)
        action = request.get("action")
        payload = request.get("payload", {})

        if action == "design":
            plan = payload.get("plan")
            available_concepts = payload.get("available_concepts", "")
            
            if not plan:
                print(json.dumps({"error": "Missing plan in payload"}))
                return

            # Plan comes in as a dict usually, convert to string for prompt
            plan_str = json.dumps(plan, indent=2) if isinstance(plan, dict) else str(plan)

            designer = ConceptDesigner()
            result = designer.generate_design(
                plan=plan_str,
                available_concepts=available_concepts
            )
            print(json.dumps(result))

        elif action == "modify":
            plan = payload.get("plan")
            current_design = payload.get("current_design")
            feedback = payload.get("feedback")
            available_concepts = payload.get("available_concepts", "")

            if not plan or not current_design or not feedback:
                 print(json.dumps({"error": "Missing required fields for modify"}))
                 return

            plan_str = json.dumps(plan, indent=2) if isinstance(plan, dict) else str(plan)
            design_str = json.dumps(current_design, indent=2) if isinstance(current_design, dict) else str(current_design)

            designer = ConceptDesigner()
            result = designer.modify_design(
                plan=plan_str,
                current_design=design_str,
                feedback=feedback,
                available_concepts=available_concepts
            )
            print(json.dumps(result))

        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))

    except Exception as e:
        # Print error to stderr to not corrupt stdout JSON
        print(f"Internal Error: {e}", file=sys.stderr)
        print(json.dumps({"error": f"Internal designer error: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
