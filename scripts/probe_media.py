#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""探测媒体文件时长（不依赖 ffmpeg CLI，纯 PyAV 容器元数据）。"""
import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少文件路径", "duration": 0}))
        return
    p = sys.argv[1]
    try:
        import av
        with av.open(p) as c:
            dur = 0.0
            if c.duration:
                dur = float(c.duration) / float(av.time_base)
            else:
                for st in c.streams:
                    if st.duration and st.time_base:
                        dur = max(dur, float(st.duration * st.time_base))
            fmt = c.format.name if c.format else ""
            vstreams = len([s for s in c.streams if s.type == "video"])
            astreams = len([s for s in c.streams if s.type == "audio"])
        print(json.dumps({"ok": True, "duration": round(dur, 1),
                          "format": fmt, "video": vstreams, "audio": astreams}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:200], "duration": 0}))


if __name__ == "__main__":
    main()
