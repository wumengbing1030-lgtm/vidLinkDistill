# -*- coding: utf-8 -*-
"""
常驻转写服务（多进程并行版）
监听 127.0.0.1:8766
  POST /transcribe        {"path": "...", "model": "small", "language": null}      -> 单文件
  POST /transcribe_batch  {"files": ["a.wav","b.wav"], "model": "small"}           -> 多文件并行
  GET  /ping                                                                       -> 健康检查

设计要点：
- 模型只在子进程里加载，主进程纯做 HTTP 调度，避免内存重复。
- 子进程数默认 = min(4, 核数//4)，每个子进程 cpu_threads=4，16 核刚好打满。
- 子进程池化复用：模型加载一次，后续请求零加载开销。
- 任何子进程崩溃都不会拖死主服务（自动重建池 + 单任务失败标记，不无限重试）。
"""
import os, sys, json, time, threading, traceback

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# 兼容补丁：faster-whisper 1.2.x 调用 av.open(..., metadata_errors=...)，av 19+ 已移除该参数
try:
    import av as _av
    _orig_av_open = _av.open

    def _patched_av_open(*a, **kw):
        kw.pop("metadata_errors", None)
        return _orig_av_open(*a, **kw)

    _av.open = _patched_av_open
except Exception:
    pass

from faster_whisper import WhisperModel

PORT = 8766
DEFAULT_MODEL = os.environ.get("WHISPER_DEFAULT_MODEL", "small")

_CPU = os.cpu_count() or 4
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "0")) or max(2, min(8, _CPU // 4))
WORKERS = int(os.environ.get("WHISPER_WORKERS", "0")) or max(1, min(4, _CPU // CPU_THREADS))

# 每个进程自己的模型缓存（子进程之间天然隔离）
_models = {}
_lock = threading.Lock()


def get_model(size):
    size = size or "small"
    with _lock:
        if size not in _models:
            t0 = time.time()
            print(f"[daemon][pid {os.getpid()}] loading model: {size} (threads={CPU_THREADS})", flush=True)
            _models[size] = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)
            print(f"[daemon][pid {os.getpid()}] model ready: {size} in {time.time() - t0:.1f}s", flush=True)
        return _models[size]


try:
    from zhconv import convert as _zh

    def _t2s(t):
        return _zh(t, "zh-cn")
except Exception:
    def _t2s(t):
        return t


def do_transcribe(path, size, language=None):
    model = get_model(size)
    t0 = time.time()
    # beam_size=1 贪心解码，速度约为 beam5 的 2 倍；condition_on_previous_text=False 防止幻觉循环
    # language=None 时自动识别语种（中英混排/英文播客必须这样，强设 zh 会明显变慢且出幻觉）
    kw = dict(
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
        vad_parameters=dict(min_silence_duration_ms=500),
    )
    if language:
        kw["language"] = language
    segments, info = model.transcribe(path, **kw)
    lines, segs = [], []
    for seg in segments:
        t = _t2s(seg.text.strip())   # whisper 中文偶发整段繁体，统一转简体
        if t:
            lines.append(t)
            segs.append({"t": round(float(seg.start or 0), 1), "e": round(float(seg.end or 0), 1), "text": t})
    return {
        "ok": True,
        "text": "\n".join(lines),
        "probs": getattr(info, "language_probability", None),
        "lines": lines,
        "segs": segs,
        "language": getattr(info, "language", language or "auto"),
        "duration": getattr(info, "duration", 0),
        "model": size,
        "elapsed": round(time.time() - t0, 1),
        "pid": os.getpid(),
    }


# ---------- 进程池（子进程执行，模型常驻） ----------
def _worker(job):
    """子进程入口：job = (path, model, language)；path='__warmup__' 表示只加载模型"""
    p, size, lang = job
    if p == "__warmup__":
        get_model(size)
        return {"ok": True, "warm": True, "pid": os.getpid()}
    if not p or not os.path.exists(p):
        return {"ok": False, "error": "媒体文件不存在: " + str(p), "path": p}
    try:
        return do_transcribe(p, size, lang)
    except Exception as e:
        return {"ok": False, "error": str(e), "path": p, "trace": traceback.format_exc()[-400:]}


_pool = None
_pool_lock = threading.Lock()
_pool_gen = 0


def get_pool():
    global _pool, _pool_gen
    with _pool_lock:
        if _pool is None:
            import multiprocessing as mp
            from concurrent.futures import ProcessPoolExecutor
            print(f"[daemon] starting pool: workers={WORKERS} cpu_threads={CPU_THREADS}", flush=True)
            _pool = ProcessPoolExecutor(max_workers=WORKERS, mp_context=mp.get_context("spawn"))
            _pool_gen += 1
        return _pool


def reset_pool():
    global _pool
    with _pool_lock:
        if _pool is not None:
            try:
                _pool.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
        _pool = None


def warmup():
    """预热：让每个子进程都把模型加载好（首次请求就不必等加载）"""
    try:
        pool = get_pool()
        futs = [pool.submit(_worker, ("__warmup__", DEFAULT_MODEL, None)) for _ in range(WORKERS)]
        for f in futs:
            try:
                f.result(timeout=5)
            except Exception:
                pass
    except Exception as e:
        print(f"[daemon] warmup skipped: {e}", flush=True)


def run_jobs(jobs):
    """jobs: [(path, model, lang)] -> [result]；顺序与入参一致"""
    if not jobs:
        return []
    try:
        pool = get_pool()
        futs = [pool.submit(_worker, j) for j in jobs]
        out = []
        for f in futs:
            try:
                out.append(f.result())
            except Exception as e:
                out.append({"ok": False, "error": "子进程异常: " + str(e)})
        return out
    except Exception as e:
        # 池坏了（子进程崩溃等）：重建一次再试，仍失败就降级串行，绝不卡死
        print(f"[daemon] pool failed ({e}), rebuilding", flush=True)
        reset_pool()
        try:
            pool = get_pool()
            return [pool.submit(_worker, j).result() for j in jobs]
        except Exception as e2:
            print(f"[daemon] pool rebuild failed ({e2}), serial fallback", flush=True)
            return [_worker(j) for j in jobs]


from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

_seen_pids = set()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/ping"):
            self._send({
                "ok": True,
                "loaded": list(_models.keys()),
                "workers": WORKERS,
                "cpu_threads": CPU_THREADS,
                "pids": sorted(_seen_pids)[:8],
            })
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        p = self.path
        if not (p.startswith("/transcribe") or p.startswith("/warmup")):
            self._send({"ok": False, "error": "not found"}, 404)
            return
        t0 = time.time()
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

            if p.startswith("/warmup"):
                warmup()
                self._send({"ok": True, "workers": WORKERS, "cpu_threads": CPU_THREADS})
                return

            size = data.get("model", DEFAULT_MODEL)
            lang = data.get("language") or None

            if p.startswith("/transcribe_batch"):
                files = [f for f in (data.get("files") or []) if f]
                if not files:
                    self._send({"ok": False, "error": "files 为空"}, 400)
                    return
                results = run_jobs([(f, size, lang) for f in files])
                for r in results:
                    if r.get("pid"):
                        _seen_pids.add(r["pid"])
                self._send({
                    "ok": True,
                    "results": results,
                    "count": len(results),
                    "failed": sum(1 for r in results if not r.get("ok")),
                    "elapsed": round(time.time() - t0, 1),
                })
                return

            path = data.get("path", "")
            if not path or not os.path.exists(path):
                self._send({"ok": False, "error": "媒体文件不存在: " + str(path)}, 400)
                return
            res = run_jobs([(path, size, lang)])[0]
            self._send(res, 200 if res.get("ok") else 500)
        except Exception as e:
            self._send({"ok": False, "error": str(e), "trace": traceback.format_exc()[-400:]}, 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("[daemon] " + (fmt % args) + "\n")


if __name__ == "__main__":
    print(f"[daemon] master pid={os.getpid()} workers={WORKERS} cpu_threads={CPU_THREADS}", flush=True)
    # 先把池建起来并预热，第一个请求就不用等模型加载
    threading.Thread(target=warmup, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[daemon] listening on http://127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
