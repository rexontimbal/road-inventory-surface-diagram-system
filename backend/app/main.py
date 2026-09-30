from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import Base, engine
from app.routers import roads

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Road Inventory & Surface Diagram System")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(roads.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
