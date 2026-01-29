import sys
sys.dont_write_bytecode = True
import json
import os
import dspy
from dotenv import load_dotenv

from api_generator import ApiGenerator
from sync_generator import SyncGenerator

load_dotenv()

def configure_dspy():
    api_key = os.getenv("GEMINI_API_KEY")
    model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")
    
    if not api_key:
        print("Warning: GEMINI_API_KEY not set", file=sys.stderr)
        return False
        
    if not model_name.startswith("gemini/") and "gemini" in model_name:
        model_name = f"gemini/{model_name}"
        
    lm = dspy.LM(model=model_name, api_key=api_key, max_tokens=64000, cache=False)
    dspy.settings.configure(lm=lm)
    return True

def main():
    # Ensure stdout encoding is utf-8 to handle any special chars in JSON
    if sys.stdout.encoding != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')

    if not configure_dspy():
        print(json.dumps({"error": "GEMINI_API_KEY not configured"}))
        return

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
    
    if action != "generate":
        print(json.dumps({"error": f"Unknown action: {action}"}))
        return

    plan = payload.get("plan")
    concept_specs = payload.get("conceptSpecs")
    
    if not plan or not concept_specs:
        print(json.dumps({"error": "Missing plan or conceptSpecs"}))
        return

    try:
        # 1. Generate API and Endpoints
        print("Generating API definition and endpoints...", file=sys.stderr)
        api_gen = ApiGenerator()
        api_result = api_gen.generate(plan, concept_specs)
        
        openapi_yaml = api_result.get("openapi_yaml", "")
        endpoints = api_result.get("endpoints", [])
        print(f"Generated {len(endpoints)} endpoints: {[f'{e.get('method')} {e.get('path')}' for e in endpoints]}", file=sys.stderr)
        
        if not endpoints:
            print("Warning: No endpoints generated.", file=sys.stderr)
        
        endpoint_bundles = []
        all_syncs = []
        
        # 2. Iterate Endpoints and Generate Syncs
        sync_gen = SyncGenerator()
        implementations = payload.get("implementations", {})

        for endpoint in endpoints:
            method = endpoint.get('method', 'UNKNOWN')
            path = endpoint.get('path', 'UNKNOWN')
            print(f"Generating syncs for {method} {path}...", file=sys.stderr)
            
            result = sync_gen.generate_syncs(endpoint, plan, concept_specs, implementations)
            
            # Result contains syncs (list), testFile, status
            syncs = result.get("syncs", [])
            test_file = result.get("testFile", "")
            sync_file = result.get("syncFile", "")
            status = result.get("status", "error")
            
            bundle = {
                "endpoint": endpoint,
                "syncs": syncs,
                "testFile": test_file,
                "syncFile": sync_file,
                "compile": {"ok": status == "complete"} 
            }
            endpoint_bundles.append(bundle)
            all_syncs.extend(syncs)
            
        # 3. Return Combined Result
        response = {
            "syncs": all_syncs,
            "apiDefinition": {
                "format": "openapi",
                "encoding": "yaml",
                "content": openapi_yaml
            },
            "endpointBundles": endpoint_bundles
        }
        
        print(json.dumps(response))
        
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": f"Internal error: {str(e)}"}))

if __name__ == "__main__":
    main()
