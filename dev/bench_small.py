"""Скільки коштує прохід малої моделі (small, cuda) по 0.5–3 с звуку. argv: wav."""
import glob, os, sys, time, wave
import numpy as np

for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
    os.add_dll_directory(d)
    os.environ['PATH'] = d + os.pathsep + os.environ['PATH']
from faster_whisper import WhisperModel

with wave.open(sys.argv[1], "rb") as w:
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
m = WhisperModel("small", device="cuda", compute_type="int8_float16")
list(m.transcribe(np.zeros(16000, np.float32), language="en")[0])
start = 16000  # 1 с тиші на початку файлу
for sec in (0.5, 0.8, 1.2, 2.0, 3.0):
    chunk = a[start: start + int(16000 * sec)]
    ts = []
    for _ in range(4):
        t = time.time()
        segs, _ = m.transcribe(chunk, language="en", beam_size=1, condition_on_previous_text=False,
                               vad_filter=False, without_timestamps=True, hotwords="Claude")
        text = " ".join(s.text for s in segs)
        ts.append(time.time() - t)
    print(f"{sec:.1f} s: {min(ts) * 1000:.0f}-{max(ts[1:]) * 1000:.0f} ms  -> {text!r}")
