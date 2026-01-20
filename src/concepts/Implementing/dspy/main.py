from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
import os
import sys

# Ensure we can import from local directory
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from implementer import ImplementerModule

app = FastAPI()
implementer = ImplementerModule()

class ImplementRequest(BaseModel):
    spec: str
    conceptName: str

class ChangeRequest(BaseModel):
    spec: str
    conceptName: str
    code: str
    tests: str
    feedback: str

class GenerateTestsRequest(BaseModel):
    spec: str
    code: str
    conceptName: str

class FixRequest(BaseModel):
    spec: str
    code: str
    tests: str
    errors: str

@app.post("/implement")
async def implement(request: ImplementRequest):
    try:
        # Since implementer.implement handles the generation and loop, we call it directly
        result = implementer.implement(
            spec=request.spec, 
            concept_name=request.conceptName
        )
        
        if result["status"] == "error":
            return {"error": result.get("error_log", "Unknown error during implementation loop")}
            
        return result
    except Exception as e:
        print(f"Error in /implement: {e}", file=sys.stderr)
        return {"error": str(e)}

@app.post("/change")
async def change(request: ChangeRequest):
    try:
        # We pass existing code and tests + feedback to trigger the update/fix loop
        result = implementer.implement(
            spec=request.spec,
            concept_name=request.conceptName,
            existing_impl=request.code,
            existing_tests=request.tests,
            feedback=request.feedback
        )
        
        if result["status"] == "error":
            return {"error": result.get("error_log", "Unknown error during change loop")}
            
        return result
    except Exception as e:
        print(f"Error in /change: {e}", file=sys.stderr)
        return {"error": str(e)}

@app.post("/generateTests")
async def generate_tests(request: GenerateTestsRequest):
    try:
        # Use the specific tester method from the module
        reference = implementer.retriever.retrieve(request.conceptName)
        ref_str = f"Example Concept: {reference['name']}\nCode:\n{reference['code']}\nTests:\n{reference['tests']}"
        
        prediction = implementer.tester(
            spec=request.spec,
            implementation_code=request.code,
            context=implementer.context,
            reference_examples=ref_str
        )
        
        return {"tests": prediction.test_code}
    except Exception as e:
        return {"error": str(e)}

@app.post("/fix")
async def fix(request: FixRequest):
    try:
        prediction = implementer.fixer(
            spec=request.spec,
            current_impl=request.code,
            current_tests=request.tests,
            error_log=request.errors
        )
        
        return {
            "code": prediction.fixed_impl,
            "tests": prediction.fixed_tests,
            "explanation": prediction.explanation
        }
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    import uvicorn
    # When running as main, listens on port defined by env or 8000
    # Note: ConceptualAI calls might expect a specific port or use the python command directly.
    # The ImplementingConcept.ts invokes it via `python src/.../main.py`.
    # Wait, the ImplementingConcept.ts uses `Deno.Command` to run the script and writes to STDIN.
    # The current `main.py` is set up as a FastAPI server.
    # We need to adapt `main.py` to handle the `ImplementingConcept.ts` CLI style (STDIN/STDOUT)
    # OR change `ImplementingConcept.ts` to use HTTP.
    # The plan said "Create main.py FastAPI server".
    # BUT `ImplementingConcept.ts` (existing code) uses CLI invocation.
    # I should support CLI invocation here to match the TypeScript implementation I wrote.
    # OR I update TypeScript implementation. 
    # Since I'm in "Implementing Agent" task, and I previously wrote the TS to use CLI,
    # I should probably make `main.py` handle CLI if arguments aren't for server.
    # Or just write a CLI wrapper that `ImplementingConcept.ts` calls.
    # 
    # Actually, the `ImplementingConcept.ts` I wrote calls `src/concepts/Implementing/dspy/main.py`
    # via `python` command and writes JSON to stdin.
    # So this main.py needs to handle that.
    
    # Check if we should run as CLI
    if len(sys.argv) > 1 and sys.argv[1] == "server":
        uvicorn.run(app, host="0.0.0.0", port=8000)
    else:
        # CLI Mode for integration with ImplementingConcept.ts
        import sys
        import json
        
        try:
            # Read input from stdin
            input_data = sys.stdin.read()
            if not input_data:
                # If no input, maybe start server? Or just exit.
                # Let's default to server if no input and no args, for standalone testing.
                # But typically stdin read blocks.
                pass
            
            payload = json.loads(input_data)
            action = payload.get("action")
            data = payload.get("payload", {})
            
            import asyncio
            
            async def run_cli():
                if action == "implement":
                    res = implementer.implement(
                        spec=data.get("spec"),
                        concept_name=data.get("conceptName")
                    )
                    print(json.dumps(res))
                
                elif action == "generateTests":
                    # Reusing logic from endpoint
                    reference = implementer.retriever.retrieve(data.get("conceptName"))
                    ref_str = f"Example Concept: {reference['name']}\nCode:\n{reference['code']}\nTests:\n{reference['tests']}"
                    prediction = implementer.tester(
                        spec=data.get("spec"),
                        implementation_code=data.get("code"),
                        context=implementer.context,
                        reference_examples=ref_str
                    )
                    print(json.dumps({"tests": prediction.test_code}))
                    
                elif action == "fix":
                    prediction = implementer.fixer(
                        spec=data.get("spec"),
                        current_impl=data.get("code"),
                        current_tests=data.get("tests"),
                        error_log=data.get("errors")
                    )
                    print(json.dumps({
                        "code": prediction.fixed_impl,
                        "tests": prediction.fixed_tests,
                        "explanation": prediction.explanation
                    }))
                    
                else:
                    print(json.dumps({"error": f"Unknown action: {action}"}))

            asyncio.run(run_cli())
            
        except Exception as e:
            # If JSON parse fails or other error, print error JSON
            print(json.dumps({"error": str(e)}))
