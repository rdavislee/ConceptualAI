import sys
sys.dont_write_bytecode = True
import json
import os
import concurrent.futures
import dspy
import yaml
from dotenv import load_dotenv
from api_generator import ApiGenerator
from sync_generator import SyncGenerator

load_dotenv()


def filter_openapi_yaml(openapi_yaml: str, successful_endpoints: set) -> str:
    """
    Filter the OpenAPI YAML to only include endpoints that have successful sync files.
    
    Args:
        openapi_yaml: The original OpenAPI YAML string
        successful_endpoints: Set of (method, path) tuples that have sync files
        
    Returns:
        Filtered OpenAPI YAML string
    """
    try:
        spec = yaml.safe_load(openapi_yaml)
        if not spec or 'paths' not in spec:
            return openapi_yaml
            
        filtered_paths = {}
        removed_count = 0
        
        for path, path_item in spec.get('paths', {}).items():
            filtered_operations = {}
            
            for method in ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']:
                if method in path_item:
                    if (method, path) in successful_endpoints:
                        filtered_operations[method] = path_item[method]
                    else:
                        removed_count += 1
                        print(f"  Removed from OpenAPI: {method.upper()} {path}", file=sys.stderr)
            
            # Only include the path if it has at least one operation
            if filtered_operations:
                # Preserve any path-level parameters
                if 'parameters' in path_item:
                    filtered_operations['parameters'] = path_item['parameters']
                filtered_paths[path] = filtered_operations
        
        spec['paths'] = filtered_paths
        
        print(f"Removed {removed_count} endpoints from OpenAPI spec.", file=sys.stderr)
        
        return yaml.dump(spec, default_flow_style=False, allow_unicode=True, sort_keys=False)
        
    except Exception as e:
        print(f"Warning: Failed to filter OpenAPI YAML: {e}", file=sys.stderr)
        return openapi_yaml  # Return original if filtering fails

def configure_dspy():
    """Configure DSPy with dual LMs: Pro for API generation, Flash for sync generation.
    
    Returns (flash_lm, pro_lm) tuple, or None if API key is missing.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    flash_model = os.getenv("GEMINI_MODEL_FLASH", os.getenv("GEMINI_MODEL", "gemini-1.5-flash"))
    pro_model = os.getenv("GEMINI_MODEL_PRO", os.getenv("GEMINI_MODEL", "gemini-1.5-pro"))
    
    if not api_key:
        print("Warning: GEMINI_API_KEY not set", file=sys.stderr)
        return None
    
    # Prefix for litellm
    if not flash_model.startswith("gemini/") and "gemini" in flash_model:
        flash_model = f"gemini/{flash_model}"
    if not pro_model.startswith("gemini/") and "gemini" in pro_model:
        pro_model = f"gemini/{pro_model}"
    
    flash_lm = dspy.LM(model=flash_model, api_key=api_key, max_tokens=64000, cache=False, temperature=0.5)
    pro_lm = dspy.LM(model=pro_model, api_key=api_key, max_tokens=64000, cache=False, temperature=0.5)
    
    # Global default is Flash (used by sync generation)
    dspy.settings.configure(lm=flash_lm)
    print(f"Configured LMs - Flash: {flash_model}, Pro: {pro_model}", file=sys.stderr)
    return flash_lm, pro_lm

def main():
    # Ensure stdout encoding is utf-8 to handle any special chars in JSON
    if sys.stdout.encoding != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')

    result = configure_dspy()
    if not result:
        print(json.dumps({"error": "GEMINI_API_KEY not configured"}))
        return
    flash_lm, pro_lm = result

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
        # 1. Generate API and Endpoints (with deep flow analysis)
        print("Generating API definition and endpoints with deep flow analysis...", file=sys.stderr)
        api_gen = ApiGenerator(pro_lm=pro_lm, flash_lm=flash_lm)
        api_result = api_gen.generate(plan, concept_specs)
        
        openapi_yaml = api_result.get("openapi_yaml", "")
        endpoints = api_result.get("endpoints", [])
        flow_analysis = api_result.get("flow_analysis", "")
        app_graph = api_result.get("app_graph", "{}")
        
        print(f"Generated {len(endpoints)} endpoints: {[f'{e.get('method')} {e.get('path')}' for e in endpoints]}", file=sys.stderr)
        print(f"Flow analysis: {len(flow_analysis)} chars, App graph: {len(app_graph)} chars", file=sys.stderr)
        
        if not endpoints:
            print("Warning: No endpoints generated.", file=sys.stderr)
        
        endpoint_bundles = []
        all_syncs = []
        
        # 2. Iterate Endpoints and Generate Syncs
        sync_gen = SyncGenerator(flash_lm=flash_lm)
        implementations = payload.get("implementations", {})

        import time
        
        def generate_sync_for_endpoint(endpoint):
            """Generate syncs for a single endpoint with Flash -> Pro escalation.
            
            Strategy:
              1. Flash model (global default) with 5 fix loop iterations.
              2. If Flash fails, escalate to Pro model with 10 fix loop iterations,
                 up to 3 attempts before giving up.
            """
            method = endpoint.get('method', 'UNKNOWN')
            path = endpoint.get('path', 'UNKNOWN')
            
            # --- Phase 1: Flash (5 fix loop iters, 1 attempt) ---
            print(f"[Flash] Attempting {method} {path} (5 fix iters)...", file=sys.stderr)
            with dspy.context(lm=flash_lm):
                result = sync_gen.generate_syncs(endpoint, plan, concept_specs, implementations, openapi_yaml, max_fix_iterations=5)
            
            sync_file = result.get("syncFile", "")
            status = result.get("status", "error")
            
            if sync_file and sync_file.strip() and status == "complete":
                print(f"[Flash] SUCCESS for {method} {path}", file=sys.stderr)
                return result
            
            print(f"[Flash] Failed for {method} {path}. Escalating to Pro model...", file=sys.stderr)
            
            # --- Phase 2: Pro (10 fix loop iters, up to 3 attempts) ---
            max_pro_attempts = 3
            for attempt in range(1, max_pro_attempts + 1):
                print(f"[Pro] Attempting {method} {path} (attempt {attempt}/{max_pro_attempts}, 10 fix iters)...", file=sys.stderr)
                time.sleep(2)  # Brief pause before retry
                
                with dspy.context(lm=pro_lm):
                    result = sync_gen.generate_syncs(endpoint, plan, concept_specs, implementations, openapi_yaml, max_fix_iterations=10)
                
                sync_file = result.get("syncFile", "")
                status = result.get("status", "error")
                
                if sync_file and sync_file.strip() and status == "complete":
                    print(f"[Pro] SUCCESS for {method} {path} on attempt {attempt}", file=sys.stderr)
                    return result
                
                print(f"[Pro] Failed for {method} {path} (attempt {attempt}/{max_pro_attempts}).", file=sys.stderr)
            
            print(f"ERROR: Failed to generate sync for {method} {path} after Flash + {max_pro_attempts} Pro attempts.", file=sys.stderr)
            return result
        
        # Use ThreadPoolExecutor to parallelize generation
        # Limit to 25 concurrent threads to respect API rate limits
        # The sync_gen object has a shared lock to serialize CPU-heavy testing
        max_workers = min(len(endpoints), 25)
        print(f"Starting parallel generation with {max_workers} threads...", file=sys.stderr)
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_endpoint = {
                executor.submit(generate_sync_for_endpoint, endpoint): endpoint 
                for endpoint in endpoints
            }
            
            completed_count = 0
            for future in concurrent.futures.as_completed(future_to_endpoint):
                completed_count += 1
                endpoint = future_to_endpoint[future]
                method = endpoint.get('method', 'UNKNOWN')
                path = endpoint.get('path', 'UNKNOWN')
                
                try:
                    result = future.result()
                    
                    print(f"Completed {method} {path} ({completed_count}/{len(endpoints)})", file=sys.stderr)
                    
                    bundle = {
                        "endpoint": endpoint,
                        "syncs": result.get("syncs", []),
                        "testFile": result.get("testFile", ""),
                        "syncFile": result.get("syncFile", ""),
                        "compile": {"ok": result.get("status") == "complete"} 
                    }
                    endpoint_bundles.append(bundle)
                    all_syncs.extend(result.get("syncs", []))
                    
                except Exception as exc:
                    print(f"ERROR: Exception generating {method} {path}: {exc}", file=sys.stderr)
                    # Add failed bundle
                    endpoint_bundles.append({
                        "endpoint": endpoint,
                        "syncs": [],
                        "testFile": "",
                        "syncFile": "",
                        "compile": {"ok": False}
                    })
        
        # 3. Validate all endpoints have sync files
        missing_syncs = []
        successful_endpoints = set()
        for bundle in endpoint_bundles:
            ep = bundle.get("endpoint", {})
            sync_file = bundle.get("syncFile", "")
            method = ep.get('method', '').lower()
            path = ep.get('path', '')
            
            if not sync_file or not sync_file.strip():
                missing_syncs.append(f"{method.upper()} {path}")
            else:
                successful_endpoints.add((method, path))
        
        if missing_syncs:
            print(f"WARNING: The following endpoints are missing sync files: {missing_syncs}", file=sys.stderr)
            print("These endpoints will NOT work in the generated application!", file=sys.stderr)
            print("Removing them from OpenAPI spec to prevent frontend from using dead endpoints...", file=sys.stderr)
            
            # Filter the OpenAPI YAML to remove failed endpoints
            openapi_yaml = filter_openapi_yaml(openapi_yaml, successful_endpoints)
            
        # 4. Return Combined Result
        response = {
            "syncs": all_syncs,
            "apiDefinition": {
                "format": "openapi",
                "encoding": "yaml",
                "content": openapi_yaml,
                "appGraph": app_graph
            },
            "endpointBundles": endpoint_bundles,
            "flowAnalysis": flow_analysis
        }
        
        print(json.dumps(response))
        
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": f"Internal error: {str(e)}"}))

if __name__ == "__main__":
    main()
