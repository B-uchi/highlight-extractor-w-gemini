"""
Qwen3-VL-32B-Thinking proposer on Modal, served with vLLM (FP8).

Deploy:  modal deploy backend/modal/proposer.py
App:     video-highlight-proposer
Fn:      propose_clips(video_url, chunk_sec, fps, max_pixels, max_model_len, prompt_text) -> list[dict]

Notes
- FP8 checkpoint (~33 GB) fits A100-80GB with large KV headroom for video context.
- vLLM ≥ 0.11 is required for Qwen3-VL; qwen-vl-utils handles video frame extraction.
- The "Thinking" model emits reasoning, THEN the answer — we extract the final JSON array.
- Caching: weights + vLLM compile cache live on a persistent Volume; the container stays warm
  (container_idle_timeout) so the model loads ONCE and is reused across a job's chunks.
- Every call logs a single `[QWEN-TUNE]` line for offline chunk/fps/resolution tuning.
"""

import json
import os
import re
import tempfile
import time

import modal

app = modal.App("video-highlight-proposer")

# Persistent cache: HF weights + vLLM compiled graphs survive across cold starts.
cache_vol = modal.Volume.from_name("qwen3vl-cache", create_if_missing=True)
CACHE_DIR = "/cache"

# Create once: modal secret create huggingface-secret HF_TOKEN=hf_xxx
hf_secret = modal.Secret.from_name("huggingface-secret")

MODEL_ID = os.environ.get("QWEN_MODEL_ID", "Qwen/Qwen3-VL-32B-Thinking-FP8")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "vllm>=0.11.0",
        "qwen-vl-utils==0.0.14",
        "transformers>=4.57.0",
        "requests>=2.31.0",
    )
    .env({
        "HF_HOME": f"{CACHE_DIR}/hf",
        "VLLM_CACHE_ROOT": f"{CACHE_DIR}/vllm",  # reuse compiled graphs across cold starts
        # debian_slim has the CUDA runtime but NOT the toolkit (no nvcc). FlashInfer's
        # sampler tries to JIT-build a CUDA kernel at startup and fails. We decode greedily
        # (temperature=0), so vLLM's native PyTorch sampler is equivalent and needs no build.
        "VLLM_USE_FLASHINFER_SAMPLER": "0",
    })
)

with image.imports():
    import requests
    from vllm import LLM, SamplingParams
    from transformers import AutoProcessor
    from qwen_vl_utils import process_vision_info

# Module-level singletons — persist across warm invocations in the same container.
_llm = None
_processor = None


def _load(max_model_len: int):
    global _llm, _processor
    if _llm is not None:
        return _llm, _processor

    t = time.time()
    print(f"[proposer] loading {MODEL_ID} (max_model_len={max_model_len}) …")
    _processor = AutoProcessor.from_pretrained(MODEL_ID, cache_dir=f"{CACHE_DIR}/hf")
    _llm = LLM(
        model=MODEL_ID,
        max_model_len=max_model_len,
        limit_mm_per_prompt={"video": 1},
        gpu_memory_utilization=0.92,
        download_dir=f"{CACHE_DIR}/hf",
        trust_remote_code=True,
    )
    print(f"[proposer] model ready in {time.time() - t:.1f}s")
    return _llm, _processor


def _extract_json_array(text: str) -> list:
    """Pull the final JSON array out of the Thinking model's reasoning+answer output."""
    text = text.strip()
    # Strip an optional <think>…</think> block if present.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    # Prefer the LAST top-level [...] block (the answer comes after the reasoning).
    matches = list(re.finditer(r"\[.*?\]", text, re.DOTALL))
    for m in reversed(matches):
        try:
            arr = json.loads(m.group())
            if isinstance(arr, list):
                return arr
        except json.JSONDecodeError:
            continue
    try:
        arr = json.loads(text)
        return arr if isinstance(arr, list) else []
    except json.JSONDecodeError:
        return []


def _validate(clips: list, chunk_sec: float) -> list:
    out = []
    tol = 2.0
    for c in clips:
        try:
            s = float(c["start_sec"]); e = float(c["end_sec"])
            if e <= s or s < 0 or e > chunk_sec + tol:
                continue
            c["start_sec"] = max(0.0, s)
            c["end_sec"] = min(chunk_sec, e)
            c.setdefault("confidence", 0.5)
            c.setdefault("rank", len(out) + 1)
            c.setdefault("title", "Highlight")
            c.setdefault("description", "")
            c.setdefault("jerseyNumber", None)
            c.setdefault("jerseyColor", None)
            out.append(c)
        except (KeyError, TypeError, ValueError):
            continue
    return out


@app.function(
    image=image,
    gpu="A100-80GB",
    volumes={CACHE_DIR: cache_vol},
    secrets=[hf_secret],
    timeout=900,
    scaledown_window=300,  # keep the container warm 5 min between calls (weights stay loaded)
)
def propose_clips(
    video_url: str,
    chunk_sec: float,
    fps: float,
    max_pixels: int,
    max_model_len: int,
    prompt_text: str,
) -> list:
    """Download a chunk, run Qwen3-VL-Thinking, return chunk-relative clip proposals."""
    cold = _llm is None
    t_load0 = time.time()
    llm, processor = _load(max_model_len)
    load_secs = time.time() - t_load0 if cold else 0.0

    video_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            video_path = f.name
            with requests.get(video_url, stream=True, timeout=120) as r:
                r.raise_for_status()
                for piece in r.iter_content(chunk_size=1 << 20):
                    f.write(piece)

        messages = [{
            "role": "user",
            "content": [
                {"type": "video", "video": video_path, "fps": fps, "max_pixels": max_pixels},
                {"type": "text", "text": prompt_text},
            ],
        }]

        prompt = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True,
        )
        _, video_inputs, video_kwargs = process_vision_info(messages, return_video_kwargs=True)

        frames = 0
        try:
            frames = int(video_inputs[0].shape[0]) if video_inputs else 0
        except Exception:
            pass

        sampling = SamplingParams(temperature=0.0, max_tokens=8192, repetition_penalty=1.05)
        t_inf0 = time.time()
        outputs = llm.generate(
            [{
                "prompt": prompt,
                "multi_modal_data": {"video": video_inputs},
                "mm_processor_kwargs": video_kwargs,
            }],
            sampling,
        )
        infer_secs = time.time() - t_inf0

        out = outputs[0]
        prompt_tokens = len(out.prompt_token_ids)
        output_tokens = len(out.outputs[0].token_ids)
        text = out.outputs[0].text

        clips = _validate(_extract_json_array(text), chunk_sec)

        tpf = round(prompt_tokens / frames, 1) if frames else 0
        headroom = max_model_len - prompt_tokens
        print(
            f"[QWEN-TUNE] chunk_sec={chunk_sec:.1f} fps={fps} max_pixels={max_pixels} "
            f"frames_sampled={frames} prompt_tokens={prompt_tokens} tokens_per_frame={tpf} "
            f"max_model_len={max_model_len} headroom_tokens={headroom} "
            f"output_tokens={output_tokens} proposals_returned={len(clips)} "
            f"load_secs={load_secs:.1f} infer_secs={infer_secs:.1f}"
        )
        if prompt_tokens > 0.9 * max_model_len:
            print(f"[QWEN-TUNE] WARN prompt_tokens={prompt_tokens} exceeds 90% of max_model_len={max_model_len} — reduce chunk_sec/fps/max_pixels")

        return clips
    except Exception as exc:
        import traceback
        print(f"[proposer] error: {exc}")
        traceback.print_exc()
        return []
    finally:
        if video_path and os.path.exists(video_path):
            os.unlink(video_path)
