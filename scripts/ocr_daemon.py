# -*- coding: utf-8 -*-
"""
常驻画面文字识别服务：启动时加载 RapidOCR 一次，之后所有请求复用。
监听 127.0.0.1:8767
  GET  /ping              -> {"ok":true,"loaded":true}
  POST /ocr  {"path":"...", "max_frames":40, "interval":0}
       -> {"ok":true,"text":...,"lines":[...],"blocks":[{t0,t1,lines:[...]}],
           "frames":n,"duration":s,"skipped_blank":k,"static_skip":m,"elapsed":x}
关键帧策略（稳定优先）：
  1) 按全片时长均匀取点，覆盖完整视频（不再只识别开头几十秒）；
  2) 黑屏/纯色帧直接跳过；
  3) 与上一张关键帧几乎一致（画面未变）则不做 OCR，只延长上一块时间；
  4) 文字与上一块高度重叠则合并成同一块（PPT 逐条出现不会重复刷屏）；
  5) 过滤 B站播放器 UI 噪声（关注/点赞/投币/弹幕…）；
  6) 采样数量有上限，超长视频自动变稀疏，绝不卡死。
"""
import os, sys, json, re, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

PORT = 8767
_engine = None
_lock = threading.Lock()

# 兼容补丁：av 19+ 移除了 metadata_errors 参数
try:
    import av as _av
    _orig_open = _av.open
    def _patched_open(*a, **kw):
        kw.pop("metadata_errors", None)
        return _orig_open(*a, **kw)
    _av.open = _patched_open
except Exception:
    pass

# 播放器 UI / 站内固定文案噪声
UI_NOISE = None


def get_engine():
    global _engine
    with _lock:
        if _engine is None:
            print("[ocr] loading RapidOCR engine...", flush=True)
            from rapidocr_onnxruntime import RapidOCR
            _engine = RapidOCR()
            print("[ocr] engine ready", flush=True)
        return _engine


def _ui_noise():
    global UI_NOISE
    if UI_NOISE is None:
        pat = (r"^(关注|已关注|点赞|投币|收藏|分享|发送|发个弹幕|弹幕|自动连播|稍后再看|播放|暂停|全屏|网页全屏|"
               r"字幕|倍速|清晰度|选集|画质|音量|设置|反馈|客户端|举报|登录|大会员|会员购|充会员|下载|"
               r"未经作者授权|禁止转载|\d+(\.\d+)?万?|\d+:\d+.*)$")
        UI_NOISE = re.compile(pat)
    return UI_NOISE


def _clean_text(t):
    t = (t or "").strip()
    return re.sub(r"\s+", " ", t)


def _valid(t, score):
    if len(t) < 2 or score < 0.5:
        return False
    if not re.search(r"[\u4e00-\u9fa5A-Za-z]", t):
        return False
    if _ui_noise().match(t):
        return False
    if len(t) <= 3 and not re.search(r"[\u4e00-\u9fa5]", t):
        return False
    return True


def do_ocr(path, interval=0, max_frames=40, url=None, headers=None, duration_hint=0):
    import av
    import numpy as np
    import cv2
    engine = get_engine()

    # 远程流式取帧：不落盘、不整段下载，ffmpeg 按需 Range 拉取
    if url:
        # 注意：不能加 protocol_whitelist，本机 ffmpeg 会直接报 Invalid argument
        opts = {"timeout": "30000000"}
        if headers:
            opts["headers"] = headers
        # .m4s 扩展名 ffmpeg 猜不出格式，必须显式指定 mp4
        container = av.open(url, format="mp4", options=opts)
    else:
        container = av.open(path)
    streams = [s for s in container.streams if s.type == "video"]
    if not streams:
        container.close()
        return {"ok": True, "text": "", "lines": [], "blocks": [], "frames": 0,
                "duration": 0, "note": "视频流中无画面轨道"}

    duration = 0.0
    if container.duration is not None:
        duration = float(container.duration) / av.time_base
    if duration <= 0:
        for s in streams:
            if s.duration is not None:
                duration = float(s.duration * (s.time_base or 0))
                break
    if duration <= 0 and duration_hint:
        duration = float(duration_hint)

    # ---- 采样点：全片均匀覆盖 + 上限 ----
    max_frames = max(6, min(int(max_frames or 40), 120))
    if duration > 0:
        step = duration / float(max_frames)
        try:
            if interval and float(interval) > step:
                step = float(interval)   # 调用方要求更稀疏
        except Exception:
            pass
        step = max(2.0, step)
        targets = []
        t = min(2.0, max(0.0, duration / 2.0))
        while t < duration - 0.5 and len(targets) < max_frames:
            targets.append(round(t, 1))
            t += step
    else:
        step = 5.0
        targets = [float(i) * step for i in range(max_frames)]

    blocks = []          # [{t0,t1,lines:[]}]
    flat = []            # 首次出现的行（去重后）
    seen_line = set()
    frames_done = 0
    skipped_blank = 0
    static_skip = 0
    prev_hash = None
    last_txt_norm = ""

    def handle_frame(img, t):
        nonlocal frames_done, skipped_blank, static_skip, prev_hash, last_txt_norm
        h, w = img.shape[:2]
        if w > 960:
            scale = 960.0 / w
            img = cv2.resize(img, (960, int(h * scale)))
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        small = cv2.resize(gray, (64, 36), interpolation=cv2.INTER_AREA)
        bright = float(small.mean())
        contrast = float(small.std())
        # 黑屏 / 上下黑边纯色 / 白屏
        if bright < 16 or contrast < 4.0:
            skipped_blank += 1
            return
        # 画面变动检测：与上一张关键帧几乎相同则跳过 OCR
        h8 = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
        ah = (h8[:, 1:] > h8[:, :-1]).flatten()
        if prev_hash is not None:
            diff = int(np.count_nonzero(ah != prev_hash))
            if diff <= 2:
                static_skip += 1
                if blocks:
                    blocks[-1]["t1"] = round(t + step, 1)
                return
        prev_hash = ah

        frames_done += 1
        res, _ = engine(img)
        texts = []
        if res:
            for item in res:
                txt = _clean_text(item[1] if len(item) > 1 else "")
                score = float(item[2]) if len(item) > 2 and item[2] else 0.0
                if _valid(txt, score):
                    texts.append(txt)
        if not texts:
            return
        # 块内去重 + 与上一块合并（文字高度重叠视为同一画面）
        uniq = []
        for x in texts:
            k = x.replace(" ", "")
            if all(k not in u.replace(" ", "") and u.replace(" ", "") not in k for u in uniq):
                uniq.append(x)
        norm = "|".join(sorted(u.replace(" ", "") for u in uniq))
        prev_set = set(x.replace(" ", "") for b in blocks[-1:] for x in b["lines"])
        cur_set = set(x.replace(" ", "") for x in uniq)
        if blocks and last_txt_norm and cur_set and prev_set and len(cur_set & prev_set) / len(cur_set | prev_set) >= 0.6:
            add = [x for x in uniq if x.replace(" ", "") not in prev_set]
            blocks[-1]["lines"].extend(add)
            blocks[-1]["t1"] = round(t + step, 1)
        else:
            blocks.append({"t0": round(t, 1), "t1": round(t + step, 1), "lines": uniq})
        last_txt_norm = norm
        for x in uniq:
            k = x.replace(" ", "")
            if k not in seen_line:
                seen_line.add(k)
                flat.append({"t": round(t, 1), "text": x})

    # seek 到每个采样点取一帧
    decode_ok = 0
    for t in targets:
        try:
            container.seek(int(t / (streams[0].time_base or av.time_base)),
                           stream=streams[0], backward=True, any_frame=False)
        except Exception:
            pass
        try:
            for frame in container.decode(video=0):
                img = frame.to_ndarray(format="rgb24")
                decode_ok += 1
                handle_frame(img, t)
                break
        except Exception as e:
            sys.stderr.write("[ocr] frame error at %.1fs: %s\n" % (t, e))

    # 兜底：seek 全失败时顺序解码一次（抽样）
    if decode_ok == 0:
        try:
            container.seek(0, stream=streams[0])
            fps = float(streams[0].average_rate or 25) or 25.0
            every = max(1, int(step * fps))
            for i, frame in enumerate(container.decode(video=0)):
                if i % every != 0:
                    continue
                img = frame.to_ndarray(format="rgb24")
                handle_frame(img, i / fps)
                if len(blocks) >= max_frames:
                    break
        except Exception as e:
            sys.stderr.write("[ocr] sequential fallback error: %s\n" % e)

    container.close()
    flat.sort(key=lambda x: x["t"])
    blocks = [b for b in blocks if b["lines"]]
    text = "\n".join(x["text"] for x in flat)
    return {
        "ok": True,
        "text": text,
        "lines": flat,
        "blocks": blocks,
        "frames": frames_done,
        "sampled": len(targets),
        "skipped_blank": skipped_blank,
        "static_skip": static_skip,
        "duration": round(duration, 1)
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/ping"):
            self._send({"ok": True, "loaded": _engine is not None, "port": PORT})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        if not self.path.startswith("/ocr"):
            self._send({"ok": False, "error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            path = data.get("path", "")
            url = data.get("url", "") or None
            headers = data.get("headers", "") or None
            interval = float(data.get("interval", 0) or 0)
            max_frames = int(data.get("max_frames", 40) or 40)
            duration_hint = float(data.get("duration", 0) or 0)
            if not url and (not path or not os.path.exists(path)):
                self._send({"ok": False, "error": "视频文件不存在: " + str(path)}, 400)
                return
            t0 = time.time()
            result = do_ocr(path, interval, max_frames, url=url, headers=headers, duration_hint=duration_hint)
            result["remote"] = bool(url)
            result["elapsed"] = round(time.time() - t0, 1)
            self._send(result)
        except Exception as e:
            self._send({"ok": False, "error": str(e)}, 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("[ocr] " + (fmt % args) + "\n")


if __name__ == "__main__":
    print("[ocr] preloading RapidOCR engine...", flush=True)
    try:
        get_engine()
    except Exception as e:
        print("[ocr] preload failed (lazy load later): %s" % e, flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("[ocr] listening on http://127.0.0.1:%d" % PORT, flush=True)
    srv.serve_forever()
