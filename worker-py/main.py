from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="video-highlights-cv-worker")


class VideoPathRequest(BaseModel):
    inputVideoPath: str


class SceneResponse(BaseModel):
    boundariesSec: list[float]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/scenes", response_model=SceneResponse)
def scenes(_: VideoPathRequest) -> SceneResponse:
    # Placeholder for PySceneDetect integration.
    return SceneResponse(boundariesSec=[])


@app.post("/audio-events")
def audio_events(_: VideoPathRequest) -> dict:
    # Placeholder for YAMNet/PANNs integration.
    return {"events": []}


@app.post("/detect-track")
def detect_track(_: VideoPathRequest) -> dict:
    # Placeholder for YOLOv8 + ByteTrack integration.
    return {"tracks": []}


@app.post("/jersey-ocr")
def jersey_ocr(_: VideoPathRequest) -> dict:
    # Placeholder for jersey OCR pipeline.
    return {"detections": []}


@app.post("/embed")
def embed(_: VideoPathRequest) -> dict:
    # Placeholder for CLIP embeddings.
    return {"embeddings": []}


@app.post("/transcribe-fast")
def transcribe_fast(_: VideoPathRequest) -> dict:
    # Placeholder for faster-whisper integration.
    return {"segments": []}
