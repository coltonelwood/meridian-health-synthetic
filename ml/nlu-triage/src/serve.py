"""
FastAPI service for patient message triage.

Endpoints:
    POST /predict - Classify a single message
    POST /batch-predict - Classify multiple messages
    GET /health - Health check

Usage:
    uvicorn src.serve:app --host 0.0.0.0 --port 8080

Author: @achen, @slee
"""

import logging
import os
import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from src.model import get_classifier, LABEL2ID
from src.preprocess import preprocess_message, preprocess_batch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Patient Message Triage API",
    description="Classifies patient portal messages by urgency level",
    version="2.1.0",
)

# Request/Response models
class PredictRequest(BaseModel):
    text: str = Field(..., description="Patient message text", min_length=1, max_length=5000)
    skip_preprocessing: bool = Field(False, description="Skip text preprocessing")
    return_all_scores: bool = Field(False, description="Return scores for all classes")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "text": "I've been having severe chest pain for the past hour and difficulty breathing",
                    "skip_preprocessing": False,
                    "return_all_scores": True,
                }
            ]
        }
    }


class PredictResponse(BaseModel):
    predicted_label: str
    confidence: float
    raw_label: Optional[str] = None
    scores: Optional[dict] = None
    processing_time_ms: float


class BatchPredictRequest(BaseModel):
    texts: List[str] = Field(..., description="List of patient messages", min_length=1, max_length=100)
    skip_preprocessing: bool = False
    return_all_scores: bool = False


class BatchPredictResponse(BaseModel):
    predictions: List[PredictResponse]
    total_processing_time_ms: float


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_path: str
    device: str


# TODO: add request queuing for batch predictions
# Right now if we get a burst of batch requests they all compete
# for GPU memory. Should use a proper task queue (Celery or similar)
# and return a job ID for async retrieval.
# @achen: looked into FastAPI BackgroundTasks but that doesn't help
# with GPU contention. Real solution is a separate worker process.


@app.on_event("startup")
async def startup():
    """Load model on startup."""
    logger.info("Loading triage model...")
    try:
        classifier = get_classifier()
        logger.info(f"Model loaded successfully on {classifier.device}")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        # Don't crash the service - health endpoint will report unhealthy
        # and k8s will restart us


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint."""
    try:
        classifier = get_classifier()
        return HealthResponse(
            status="healthy",
            model_loaded=True,
            model_path=os.environ.get("TRIAGE_MODEL_PATH", "default"),
            device=classifier.device,
        )
    except Exception:
        return HealthResponse(
            status="unhealthy",
            model_loaded=False,
            model_path=os.environ.get("TRIAGE_MODEL_PATH", "not set"),
            device="unknown",
        )


@app.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest):
    """Classify a single patient message."""
    start = time.time()

    try:
        classifier = get_classifier()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Model not available: {str(e)}")

    # Preprocess
    text = request.text
    if not request.skip_preprocessing:
        text = preprocess_message(text)

    if not text.strip():
        raise HTTPException(status_code=400, detail="Message is empty after preprocessing")

    # Predict
    result = classifier.predict(text, return_all_scores=request.return_all_scores)

    elapsed_ms = (time.time() - start) * 1000

    return PredictResponse(
        predicted_label=result["predicted_label"],
        confidence=result["confidence"],
        raw_label=result.get("raw_label"),
        scores=result.get("scores"),
        processing_time_ms=round(elapsed_ms, 2),
    )


@app.post("/batch-predict", response_model=BatchPredictResponse)
async def batch_predict(request: BatchPredictRequest):
    """Classify multiple patient messages.

    More efficient than calling /predict multiple times because
    inference is batched on the GPU.
    """
    start = time.time()

    try:
        classifier = get_classifier()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Model not available: {str(e)}")

    # Preprocess
    texts = request.texts
    if not request.skip_preprocessing:
        texts = preprocess_batch(texts)

    # Filter empty texts
    valid_texts = [t for t in texts if t.strip()]
    if not valid_texts:
        raise HTTPException(status_code=400, detail="All messages are empty after preprocessing")

    # Batch predict
    results = classifier.predict_batch(
        valid_texts,
        return_all_scores=request.return_all_scores,
    )

    elapsed_ms = (time.time() - start) * 1000

    predictions = [
        PredictResponse(
            predicted_label=r["predicted_label"],
            confidence=r["confidence"],
            raw_label=r.get("raw_label"),
            scores=r.get("scores"),
            processing_time_ms=round(elapsed_ms / len(results), 2),
        )
        for r in results
    ]

    return BatchPredictResponse(
        predictions=predictions,
        total_processing_time_ms=round(elapsed_ms, 2),
    )


# Middleware for request logging
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    elapsed = time.time() - start

    logger.info(
        f"{request.method} {request.url.path} "
        f"status={response.status_code} "
        f"time={elapsed*1000:.1f}ms"
    )

    return response


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "src.serve:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8080)),
        workers=1,  # only 1 worker because of GPU memory
        # reload=True,  # uncomment for development
    )
