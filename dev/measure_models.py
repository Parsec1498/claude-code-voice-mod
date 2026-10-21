"""Заміри пам'яті моделей каталогу (hooks/models.ts): відеопам'ять на CUDA
(int8_float16) і RAM на CPU (int8), розмір на диску. Виводить JSON-рядок на модель.

    & "$env:USERPROFILE\\.claude\\voice-mod\\venv\\Scripts\\python.exe" dev/measure_models.py > models.jsonl

Докачує бракуючі моделі в $HF_HOME (дефолт — hf у теці мода) і лишає їх там.
Кожна пара (пристрій, модель) міряється у СВОЄМУ дочірньому процесі, інакше
кеш розподільника й контекст CUDA попередньої моделі спотворять різницю.
Живий слухач не чіпається: VRAM — різниця nvidia-smi до/після в дочірньому
процесі (слухач, якщо працює, тримає свою частку незмінною).
"""
import glob
import json
import os
import subprocess
import sys
import time
from pathlib import Path

MODELS = ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en",
          "large-v3-turbo", "distil-large-v3", "large-v3"]
HOME = Path(os.environ.get("USERPROFILE", "~")).expanduser() / ".claude" / "voice-mod"


def used_vram_mb() -> int | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=20, check=True).stdout
        return int(out.strip().splitlines()[0])
    except Exception:  # noqa: BLE001 — нема nvidia-smi / GPU
        return None


def working_set_mb() -> float:
    """Робочий набір поточного процесу (psutil, інакше GetProcessMemoryInfo)."""
    try:
        import psutil
        return psutil.Process().memory_info().rss / 2**20
    except ImportError:
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

        c = Counters()
        c.cb = ctypes.sizeof(c)
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if not psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb):
            raise ctypes.WinError(ctypes.get_last_error()) from None
        return c.WorkingSetSize / 2**20


def dir_size_mb(path: str) -> float:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))  # через символьні посилання snapshots → blobs
    return total / 2**20


def child(device: str, name: str) -> None:
    """Один прохід: завантажити, прогнати 1 с тиші, надрукувати різницю пам'яті."""
    for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]
    import numpy as np
    from faster_whisper import WhisperModel

    cuda = device == "cuda"
    v0, r0 = used_vram_mb(), working_set_mb()
    m = WhisperModel(name, device=device, compute_type="int8_float16" if cuda else "int8",
                     cpu_threads=max(1, (os.cpu_count() or 4) // 2))
    segs, _ = m.transcribe(np.zeros(16000, np.float32), language="en", beam_size=1,
                           without_timestamps=True, vad_filter=False)
    list(segs)
    time.sleep(0.5)  # nvidia-smi оновлюється із запізненням
    v1, r1 = used_vram_mb(), working_set_mb()
    print(json.dumps({"vramMb": (v1 - v0) if cuda and v0 is not None and v1 is not None else None,
                      "ramMb": round(r1 - r0)}))


def main() -> None:
    os.environ["HF_HUB_OFFLINE"] = "0"  # докачування дозволене власником
    os.environ.setdefault("HF_HOME", str(HOME / "hf"))
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    from faster_whisper.utils import download_model

    for name in MODELS:
        row: dict = {"name": name}
        try:
            path = download_model(name)
            row["diskMb"] = round(dir_size_mb(path))
            for device in ("cuda", "cpu"):
                r = subprocess.run([sys.executable, __file__, "--child", device, name],
                                   capture_output=True, text=True, timeout=1800)
                if r.returncode != 0:
                    raise RuntimeError(f"{device}: {(r.stderr or r.stdout).strip()[-400:]}")
                got = json.loads(r.stdout.strip().splitlines()[-1])
                if device == "cuda":
                    row["vramMb"] = got["vramMb"]
                else:
                    row["ramMb"] = got["ramMb"]
        except Exception as e:  # noqa: BLE001 — рядок із error, решта моделей міряється далі
            row["error"] = f"{type(e).__name__}: {e}"
        print(json.dumps(row, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--child":
        child(sys.argv[2], sys.argv[3])
    else:
        main()
