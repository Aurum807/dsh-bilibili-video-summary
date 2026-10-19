#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""faster-whisper 转写助手。

由 video-material.mjs 在探测到本地装有 faster_whisper 时调用。
输出格式与 vidsum.py 一致，每行：[起-止] 文本

用法:
    python faster_whisper_asr.py --audio A.m4a --out T.txt [--model small] [--lang zh]
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--beam-size", type=int, default=5)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print("faster_whisper 不可用: %s" % exc, file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    # vad_filter=True 在本机会恒定返回 0 段，必须关闭（vidsum.py 里也是这么写的）。
    segments, info = model.transcribe(
        args.audio,
        language=args.lang or None,
        beam_size=args.beam_size,
        vad_filter=False,
    )

    lines = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        lines.append("[%.1f-%.1f] %s" % (seg.start, seg.end, text))
        if len(lines) % 50 == 0:
            print("...%d 段 (%.0fs)" % (len(lines), seg.end), file=sys.stderr)

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    print("完成 %d 段 / 语言=%s" % (len(lines), info.language), file=sys.stderr)
    return 0 if lines else 3


if __name__ == "__main__":
    sys.exit(main())
