# -*- coding: utf-8 -*-
"""把音频按秒切成 16k 单声道 wav 分片（无需 ffmpeg，用 PyAV 解码）
用法: python split_audio.py <input> <outdir> [chunk_sec]
输出: <outdir>/chunk_000.wav ... 以及 <outdir>/chunks.json {"duration":x,"chunks":[{"file","start","end"}]}
"""
import sys, os, json, wave, math

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: split_audio.py <input> <outdir> [chunk_sec]"}))
        return 1
    src_path, outdir = sys.argv[1], sys.argv[2]
    chunk = float(sys.argv[3]) if len(sys.argv) > 3 else 300.0
    os.makedirs(outdir, exist_ok=True)

    import av
    src = av.open(src_path)
    if not src.streams.audio:
        print(json.dumps({"ok": False, "error": "该媒体文件不含音轨，无法做语音转写"}))
        return 2
    st = src.streams.audio[0]
    duration = 0.0
    if src.duration:
        duration = float(src.duration) / av.time_base
    if duration <= 0 and st.duration:
        duration = float(st.duration * (st.time_base or 0))
    n = max(1, int(math.ceil(duration / chunk)))

    res = av.AudioResampler(format="s16", layout="mono", rate=16000)
    idx = -1
    w = None
    info = []
    written = 0.0

    def open_chunk(i):
        p = os.path.join(outdir, "chunk_%03d.wav" % i)
        f = wave.open(p, "wb")
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)
        return f, p

    end = min(chunk, duration or chunk)
    w, p = open_chunk(0)
    idx = 0
    start_t = 0.0
    for frame in src.decode(st):
        t = float(frame.pts * frame.time_base) if frame.pts is not None else written
        for f in res.resample(frame):
            arr = f.to_ndarray()
            w.writeframes(arr.tobytes())
            written += arr.shape[1] / 16000.0
        if t >= end and idx < n - 1:
            w.close()
            info.append({"file": p, "start": round(start_t, 1), "end": round(min(end, duration or end), 1)})
            idx += 1
            start_t = end
            end = min(start_t + chunk, duration or (start_t + chunk))
            w, p = open_chunk(idx)
    # 收尾
    for f in res.resample(None):
        w.writeframes(f.to_ndarray().tobytes())
    w.close()
    info.append({"file": p, "start": round(start_t, 1), "end": round(written, 1)})
    src.close()

    meta = {"ok": True, "duration": round(written, 1), "chunks": info}
    with open(os.path.join(outdir, "chunks.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    print(json.dumps({"ok": True, "duration": round(written, 1), "count": len(info), "dir": outdir}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
