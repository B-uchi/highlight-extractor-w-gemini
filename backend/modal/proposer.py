"""
Qwen3-VL-32B-Thinking proposer on Modal, served with vLLM (FP8).

Deploy:  modal deploy backend/modal/proposer.py
App:     video-highlight-proposer
Fn:      propose_clips(items, fps, max_pixels, max_model_len) -> list[list]
         items: [{"video_url", "chunk_sec", "prompt"}, ...] — batched via vLLM continuous batching

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
        "decord>=0.6.0",  # self-contained video reader for qwen-vl-utils
        "requests>=2.31.0",
    )
    .env({
        "HF_HOME": f"{CACHE_DIR}/hf",
        "VLLM_CACHE_ROOT": f"{CACHE_DIR}/vllm",  # reuse compiled graphs across cold starts
        # debian_slim has the CUDA runtime but NOT the toolkit (no nvcc). FlashInfer's
        # sampler tries to JIT-build a CUDA kernel at startup and fails. We decode greedily
        # (temperature=0), so vLLM's native PyTorch sampler is equivalent and needs no build.
        "VLLM_USE_FLASHINFER_SAMPLER": "0",
        # Force decord — the torchvision shipped with vLLM lacks read_video, and decord is
        # faster and self-contained. Avoids the "torchvision.io has no attribute read_video" crash.
        "FORCE_QWENVL_VIDEO_READER": "decord",
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
    # Idle warm containers are billed. Keep just enough warmth to span a job's chunks
    # without paying for a long idle tail after it finishes.
    scaledown_window=90,
)
def propose_clips(
    items: list,
    fps: float,
    max_pixels: int,
    max_model_len: int,
) -> list:
    """
    Process a BATCH of chunks in one call. `items` is a list of
    {"video_url", "chunk_sec", "prompt"}. All chunks are fed to a single
    llm.generate() so vLLM continuous-batches them on the GPU concurrently.
    Returns one proposal list per input item (aligned by index).
    """
    cold = _llm is None
    t_load0 = time.time()
    llm, processor = _load(max_model_len)
    load_secs = time.time() - t_load0 if cold else 0.0

    patch_size = getattr(getattr(processor, "image_processor", None), "patch_size", 16)
    # Thinking model burns output tokens on reasoning before the JSON answer.
    sampling = SamplingParams(temperature=0.0, max_tokens=16384, repetition_penalty=1.05)

    def _frame_count(v):
        arr = v[0] if isinstance(v, (tuple, list)) else v
        try:
            return int(arr.shape[0])
        except Exception:
            return 0

    results = [[] for _ in items]
    video_paths = []
    gen_inputs = []
    frame_counts = []
    valid_idx = []  # item indices that built successfully

    try:
        for i, it in enumerate(items):
            try:
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
                    vp = f.name
                    with requests.get(it["video_url"], stream=True, timeout=120) as r:
                        r.raise_for_status()
                        for piece in r.iter_content(chunk_size=1 << 20):
                            f.write(piece)
                video_paths.append(vp)

                messages = [{
                    "role": "user",
                    "content": [
                        {"type": "video", "video": vp, "fps": fps, "max_pixels": max_pixels},
                        {"type": "text", "text": it["prompt"]},
                    ],
                }]
                prompt = processor.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True,
                )
                # vLLM 0.11's Qwen3-VL parser unpacks each video item as (array, metadata).
                try:
                    _, video_inputs, video_kwargs = process_vision_info(
                        messages, image_patch_size=patch_size,
                        return_video_kwargs=True, return_video_metadata=True,
                    )
                except TypeError:
                    _, video_inputs, video_kwargs = process_vision_info(
                        messages, return_video_kwargs=True,
                    )

                frame_counts.append(_frame_count(video_inputs[0]) if video_inputs else 0)
                gen_inputs.append({
                    "prompt": prompt,
                    "multi_modal_data": {"video": video_inputs},
                    "mm_processor_kwargs": video_kwargs,
                })
                valid_idx.append(i)
            except Exception as exc:
                print(f"[proposer] item {i} prep failed: {exc}")

        if not gen_inputs:
            return results

        t_inf0 = time.time()
        outputs = llm.generate(gen_inputs, sampling)  # ← vLLM continuous batching
        infer_secs = time.time() - t_inf0

        for k, out in enumerate(outputs):
            i = valid_idx[k]
            chunk_sec = float(items[i]["chunk_sec"])
            prompt_tokens = len(out.prompt_token_ids)
            output_tokens = len(out.outputs[0].token_ids)
            clips = _validate(_extract_json_array(out.outputs[0].text), chunk_sec)
            results[i] = clips

            frames = frame_counts[k]
            tpf = round(prompt_tokens / frames, 1) if frames else 0
            budget_pct = round(100.0 * prompt_tokens / max_model_len, 1)
            print(
                f"[QWEN-TUNE] batch_size={len(gen_inputs)} chunk_sec={chunk_sec:.1f} fps={fps} "
                f"max_pixels={max_pixels} frames_sampled={frames} prompt_tokens={prompt_tokens} "
                f"tokens_per_frame={tpf} budget_pct={budget_pct} max_model_len={max_model_len} "
                f"output_tokens={output_tokens} proposals_returned={len(clips)}"
            )
            if prompt_tokens > 0.9 * max_model_len:
                print(f"[QWEN-TUNE] WARN prompt_tokens={prompt_tokens} > 90% of max_model_len={max_model_len}")

        per_chunk = infer_secs / max(1, len(gen_inputs))
        print(
            f"[QWEN-TUNE] BATCH_DONE items={len(items)} processed={len(gen_inputs)} "
            f"batch_infer_secs={infer_secs:.1f} per_chunk_secs={per_chunk:.1f} load_secs={load_secs:.1f}"
        )
        return results
    except Exception as exc:
        import traceback
        print(f"[proposer] batch error: {exc}")
        traceback.print_exc()
        return results
    finally:
        for vp in video_paths:
            if vp and os.path.exists(vp):
                os.unlink(vp)
