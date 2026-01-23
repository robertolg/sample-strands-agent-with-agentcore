"""Health check endpoints"""

from fastapi import APIRouter

router = APIRouter(tags=["health"])

@router.get("/health")
async def health_check():
    return {"status": "healthy", "service": "agent-core", "version": "2.0.0"}

@router.get("/ping")
async def ping():
    return {"status": "pong"}
