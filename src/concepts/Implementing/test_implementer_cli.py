import json
import os
import argparse
import sys
from datetime import datetime

# Add dspy directory to path so we can import ImplementerModule
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dspy"))
from implementer import ImplementerModule

OUTPUT_BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manual_test_generated_concepts")

def load_design(design_path):
    """Loads a design from a JSON file."""
    try:
        with open(design_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading design: {e}")
        return None

def save_concept_artifacts(project_id, instance_name, spec, implementation, tests):
    """Saves concept artifacts to a dedicated folder."""
    concept_dir = os.path.join(OUTPUT_BASE_DIR, project_id, instance_name)
    if not os.path.exists(concept_dir):
        os.makedirs(concept_dir)
        
    # Save Spec
    with open(os.path.join(concept_dir, f"{instance_name}.md"), "w", encoding="utf-8") as f:
        f.write(spec)
        
    # Save Implementation
    with open(os.path.join(concept_dir, f"{instance_name}Concept.ts"), "w", encoding="utf-8") as f:
        f.write(implementation)
        
    # Save Tests
    with open(os.path.join(concept_dir, f"{instance_name}.test.ts"), "w", encoding="utf-8") as f:
        f.write(tests)
        
    print(f"Saved artifacts for {instance_name} to {concept_dir}")

def main():
    parser = argparse.ArgumentParser(description="Manual CLI for testing the Implementing Agent")
    parser.add_argument("--design", type=str, help="Path to JSON design file (required)", required=True)
    parser.add_argument("--id", type=str, help="Project ID for output folder", default=None)
    
    args = parser.parse_args()
    
    project_id = args.id
    if not project_id:
        project_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    
    print(f"--- Implementing Agent Interactive Test (Project: {project_id}) ---")
    
    # 1. Load Design
    design = load_design(args.design)
    if not design:
        return
        
    implementer = ImplementerModule()
    
    # 2. Process Library Pulls
    print("\n--- Processing Library Pulls ---")
    library_pulls = design.get("libraryPulls", [])
    for pull in library_pulls:
        library_name = pull.get("libraryName")
        
        print(f"\nProcessing {library_name} (Library: {library_name})...")
        
        # Simulate retrieval/pull (This part mimics ImplementingConcept.ts logic but using the python module's retriever if possible, 
        # or we rely on the agent to 'implement' it if we want to test that path. 
        # The prompt asks to 'implement the whole thing'. 
        # For library pulls, usually we just download. 
        # But the prompt says 'implement the whole thing... with its .md spec, .ts impl, and .test.ts test file. Should have all library pulls and custom concepts.'
        # So we should probably fetch them.)
        
        # We can use the retriever from ImplementerModule to fetch the code/tests/spec
        # The retriever currently returns {name, code, tests}. It might miss spec if it's not in the file scan.
        # Let's try to retrieve.
        
        retrieved = implementer.retriever.retrieve(library_name)
        if retrieved.get("name") != "None":
            code = retrieved.get("code", "")
            tests = retrieved.get("tests", "")
            spec = retrieved.get("spec", "")
                
            if not spec:
                spec = f"### Concept: {library_name} (Pulled from {library_name})\n\nSee library documentation."
            
            save_concept_artifacts(project_id, library_name, spec, code, tests)
        else:
            print(f"Failed to retrieve library concept: {library_name}")

    # 3. Process Custom Concepts
    print("\n--- Processing Custom Concepts ---")
    custom_concepts = design.get("customConcepts", [])
    for concept in custom_concepts:
        name = concept.get("name")
        spec = concept.get("spec")
        print(f"\nImplementing Custom Concept: {name}...")
        
        # Call Implementer Agent
        result = implementer.implement(spec=spec, concept_name=name)
        
        if result.get("status") == "complete":
            print(f"Success! Iterations: {result.get('iterations')}")
            save_concept_artifacts(project_id, name, spec, result.get("code"), result.get("tests"))
        else:
            print(f"Failed to implement {name}. Status: {result.get('status')}")
            if result.get("error_log"):
                print(f"Error Log:\n{result.get('error_log')}")
                # Save partial results for debugging
                save_concept_artifacts(project_id, name, spec, result.get("code", ""), result.get("tests", ""))

    print(f"\nDone! Check 'manual_test_generated_concepts/{project_id}' directory.")

if __name__ == "__main__":
    main()
