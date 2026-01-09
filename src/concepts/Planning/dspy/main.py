from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

app = FastAPI()

class InitiateRequest(BaseModel):
    project_id: str
    description: str

class ClarifyRequest(BaseModel):
    project_id: str
    answers: Dict[str, Any]
    previous_clarifications: List[Dict[str, Any]]
    original_description: str

class PlanResponse(BaseModel):
    status: str
    plan: Optional[Dict[str, Any]] = None
    questions: Optional[List[str]] = None

@app.post("/initiate", response_model=PlanResponse)
async def initiate_plan(request: InitiateRequest):
    # Call DSPy planner here
    pass

@app.post("/clarify", response_model=PlanResponse)
async def clarify_plan(request: ClarifyRequest):
    # Call DSPy planner with history
    pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)

