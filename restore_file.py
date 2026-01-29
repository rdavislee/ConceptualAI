import subprocess
import os

file_path = "src/concepts/SyncGenerating/dspy/sync_generator.py"
try:
    # Get content from HEAD
    result = subprocess.run(
        ["git", "show", f"HEAD:{file_path}"], 
        capture_output=True, 
        text=True, 
        encoding='utf-8',
        check=True
    )
    content = result.stdout
    
    # Write to file
    with open(file_path, "w", encoding='utf-8') as f:
        f.write(content)
        
    print(f"Successfully restored {file_path} from HEAD.")
except subprocess.CalledProcessError as e:
    print(f"Git command failed: {e.stderr}")
except Exception as e:
    print(f"Error: {e}")
