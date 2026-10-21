"""Озвучення відповідей агента: Piper окремим процесом з окремого venv.

Модуль опційний: ставиться лише на натиск людини (`ttsInstall` у control.json) у
`<home>\\tts\\venv`, голоси — у `<home>\\tts\\voices\\<голос>.onnx(.json)`.

Ліцензійна межа: мод (MIT) Piper (GPL-3.0) НЕ імпортує і його коду не містить — лише
запускає `<home>\\tts\\venv\\Scripts\\python.exe -m piper -m <голос.onnx> --output_raw`
окремим процесом: текст — у stdin одним рядком, сирий int16 моно — зі stdout; закритий
stdin (EOF) = кінець висловлювання. Піпер пише звук по реченнях і скидає stdout після
кожного, тож перше речення звучить, поки синтезується друге.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

# Ті самі значення, що DEFAULT_VOICE у hooks/speak.ts (звіряє dev/words_check.py).
DEFAULT_VOICE: dict[str, str] = {
    "uk": "uk_UA-ukrainian_tts-medium",
    "en": "en_US-joe-medium",
}
PIPER_REQ = "piper-tts==1.8.0"
VOICES_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
FRESH_MS = 60_000     # speak.json, старший за це, — не озвучується
WAIT_MS = 30_000      # стільки блок чекає на диктовку/команду, далі відкидається
DEAF_TAIL_S = 0.3     # після кінця звуку мікрофон ще глухий
SAY_TIMEOUT_S = 60.0  # процес Piper на один блок
STEP_TIMEOUT_S = 1800.0  # venv/pip на повільній мережі
NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
CHUNK = 8192

_VOICE = re.compile(r"^([a-z]{2,3})_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$")

# Прогрес встановлення для `msg` у bus.json — як «⬇ модель: X ГБ» у докачки моделей.
MSG: dict[str, dict[str, str]] = {
    "uk": {
        "venv": "Piper: створюю venv",
        "pip": "⬇ Piper (pip): {mb} МБ",
        "voice": "⬇ {name}: {mb} МБ",
        "voice_total": "⬇ {name}: {mb}/{total} МБ",
        "test": "Piper: пробний синтез",
    },
    "en": {
        "venv": "Piper: creating venv",
        "pip": "⬇ Piper (pip): {mb} MB",
        "voice": "⬇ {name}: {mb} MB",
        "voice_total": "⬇ {name}: {mb}/{total} MB",
        "test": "Piper: test synthesis",
    },
}


# ---------------------------------------------------------------- чисті функції

def valid_voice(name: object) -> bool:
    """Назва голосу Piper `<код>-<голос>-<якість>`: з неї складаються шлях і URL."""
    return isinstance(name, str) and _VOICE.match(name) is not None


def voice_urls(name: str) -> tuple[str, str]:
    """(`.onnx`, `.onnx.json`) голосу в rhasspy/piper-voices на Hugging Face."""
    if not valid_voice(name):
        raise ValueError(f"не назва голосу Piper: {name!r}")
    code, voice, quality = name.split("-")
    family = code.split("_")[0]
    base = f"{VOICES_URL}/{family}/{code}/{voice}/{quality}/{name}"
    return f"{base}.onnx", f"{base}.onnx.json"


def _ms(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value)


def fresh_request(data: dict, last_seq: float, started_ms: float, now_ms: float) -> bool:
    """Новий запит speak.json: новий `seq`, `at` не старший за 60 с і за старт слухача."""
    seq, at = _ms(data.get("seq")), _ms(data.get("at"))
    return seq > last_seq and at > 0 and at >= started_ms and now_ms - at <= FRESH_MS


def deaf(now: float, busy: bool, deaf_until: float) -> bool:
    """Чи викидати кадри мікрофона: звучить озвучка або ще не минув хвіст після неї."""
    return busy or now < deaf_until


def speak_action(now_ms: float, at_ms: float, collecting: bool) -> str:
    """say — озвучити зараз; wait — людина диктує/команда розпізнається; drop — чекали задовго."""
    if now_ms - at_ms > WAIT_MS:
        return "drop"
    return "wait" if collecting else "say"


def one_line(text: str) -> str:
    """Піпер читає stdin по рядках: блок — один рядок (рядки блоку через пробіл)."""
    return " ".join(text.split())


def tts_python(tts_dir: Path) -> Path:
    return tts_dir / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def base_python() -> str:
    """Python, з якого зроблено venv слухача: з нього ж робимо venv Piper."""
    return getattr(sys, "_base_executable", None) or sys.executable


def child_env() -> dict[str, str]:
    # Обгортка venv слухача кладе __PYVENV_LAUNCHER__ у середовище: базовий Python,
    # що його успадкував, вважав би себе venv слухача (і venv Piper вийшов би кривим).
    drop = {"__PYVENV_LAUNCHER__", "VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH"}
    return {k: v for k, v in os.environ.items() if k.upper() not in drop}


def sample_rate(onnx: Path) -> int:
    """Частота голосу з `<голос>.onnx.json` → audio.sample_rate."""
    data = json.loads(Path(f"{onnx}.json").read_text("utf-8"))
    rate = data["audio"]["sample_rate"]
    if isinstance(rate, bool) or not isinstance(rate, int) or rate <= 0:
        raise ValueError(f"sample_rate: {rate!r}")
    return rate


def last_line(path: Path) -> str:
    """Остання непорожня строка журналу — зазвичай сам виняток."""
    try:
        lines = [ln for ln in path.read_text("utf-8", "replace").splitlines() if ln.strip()]
    except OSError:
        return ""
    return lines[-1].strip()[:300] if lines else ""


def dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


class _Failed(Exception):
    pass


class _Aborted(Exception):
    pass


# ---------------------------------------------------------------- встановлення

class TtsInstaller:
    """Встановлення Piper і докачка голосів фоновим потоком (по одній задачі за раз).

    Кроки встановлення: venv з базового Python → `pip install piper-tts==1.8.0` →
    голос → пробний синтез; успіх позначає `tts\\installed.json`. Дочірні процеси — з
    CREATE_NO_WINDOW, вивід — у журнал `log`. Спільне з головним циклом — під `lock`.
    """

    def __init__(self, home: Path, log: Path):
        self.dir = home / "tts"
        self.voices_dir = self.dir / "voices"
        self.python = tts_python(self.dir)
        self.marker = self.dir / "installed.json"
        self.log = log
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.jobs: list[tuple[str, str]] = []  # ("install" | "voice", голос)
        self.current: tuple[str, str] | None = None
        self.step: tuple[str, dict] | None = None  # (ключ MSG, поля)
        self.results: list[str | None] = []
        self.voice_results: list[tuple[str, str | None]] = []
        self.proc: subprocess.Popen | None = None
        self.gen = 0  # росте на remove()/abort(): задачі старшого покоління мовчки зупиняються

    # -- стан

    def installed(self) -> bool:
        return self.marker.exists() and self.python.exists()

    def has_voice(self, name: str) -> bool:
        return (self.voices_dir / f"{name}.onnx").exists() and (self.voices_dir / f"{name}.onnx.json").exists()

    def voices(self) -> list[str]:
        try:
            names = {p.name[: -len(".onnx")] for p in self.voices_dir.glob("*.onnx")}
        except OSError:
            return []
        return sorted(n for n in names if self.has_voice(n))

    def running(self) -> bool:
        with self.lock:
            return self.thread is not None

    def progress(self, lang: str = "uk") -> str | None:
        with self.lock:
            step = self.step
        if step is None:
            return None
        table = MSG.get(lang, MSG["uk"])
        return table[step[0]].format(**step[1])

    def take(self) -> list[str | None]:
        """Результати встановлень: None — успіх, рядок — причина збою."""
        with self.lock:
            out, self.results = self.results, []
            return out

    def take_voices(self) -> list[tuple[str, str | None]]:
        """Результати докачки голосів через ensure_voice: (голос, помилка або None)."""
        with self.lock:
            out, self.voice_results = self.voice_results, []
            return out

    # -- задачі

    def start(self, voice: str) -> bool:
        """Почати встановлення (з голосом `voice`); False — уже встановлюється."""
        with self.lock:
            if (self.current and self.current[0] == "install") or any(k == "install" for k, _ in self.jobs):
                return False
            self.jobs.append(("install", voice))
            self._kick()
        return True

    def ensure_voice(self, name: str) -> bool:
        """True — голос уже на диску; інакше ставить докачку в чергу (раз) і дає False."""
        if not valid_voice(name):
            return False
        if self.has_voice(name):
            return True
        with self.lock:
            job = ("voice", name)
            if self.current != job and job not in self.jobs:
                self.jobs.append(job)
                self._kick()
        return False

    def abort(self) -> None:
        """Зупинити поточну задачу (вбити дочірній процес) і забути чергу."""
        with self.lock:
            self.gen += 1
            self.jobs.clear()
            proc, thread = self.proc, self.thread
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass
        if thread is not None:
            thread.join(10)

    def remove(self) -> str | None:
        """Стерти tts\\ цілком (Piper, голоси); причина збою або None."""
        self.abort()
        err = None
        for _ in range(10):  # файли щойно вбитого процесу Windows відпускає не одразу
            try:
                shutil.rmtree(self.dir)
                return None
            except FileNotFoundError:
                return None
            except OSError as exc:
                err = repr(exc)
                time.sleep(0.3)
        return err

    def _kick(self) -> None:  # під lock
        if self.thread is None:
            self.thread = threading.Thread(target=self._worker, daemon=True)
            self.thread.start()

    def _worker(self) -> None:
        while True:
            with self.lock:
                if not self.jobs:
                    self.thread, self.current, self.step = None, None, None
                    return
                job = self.current = self.jobs.pop(0)
                gen = self.gen
            kind, name = job
            err: str | None = None
            try:
                if kind == "install":
                    self._install(name, gen)
                else:
                    self._download(name, gen)
            except _Aborted:
                continue
            except _Failed as exc:
                err = str(exc) or "?"
            except Exception as exc:  # noqa: BLE001 — будь-який збій іде людині, а не вбиває потік
                err = repr(exc)
            with self.lock:
                self.step = None
                if gen != self.gen:
                    continue  # видалили посеред задачі — результат нікому не потрібен
                if kind == "install":
                    self.results.append(err)
                else:
                    self.voice_results.append((name, err))

    def _set(self, key: str, **fields) -> None:
        with self.lock:
            self.step = (key, fields)

    def _check(self, gen: int) -> None:
        with self.lock:
            if gen != self.gen:
                raise _Aborted

    def _install(self, voice: str, gen: int) -> None:
        if not valid_voice(voice):
            raise _Failed(f"голос: {voice!r}")
        self.dir.mkdir(parents=True, exist_ok=True)
        self.log.write_text("", "utf-8")
        if not self.python.exists():
            self._set("venv")
            self._run([base_python(), "-m", "venv", str(self.dir / "venv")], gen)
        self._set("pip", mb=0)
        self._run([str(self.python), "-m", "pip", "install", "--disable-pip-version-check",
                   "--no-input", PIPER_REQ], gen, watch=self.dir / "venv")
        if not self.has_voice(voice):
            self._download(voice, gen)
        self._set("test")
        self._probe(voice, gen)
        self.marker.write_text(json.dumps({"piper": PIPER_REQ, "voice": voice,
                                           "at": int(time.time() * 1000)}), "utf-8")

    def _run(self, cmd: list[str], gen: int, watch: Path | None = None) -> None:
        self._check(gen)
        with open(self.log, "a", encoding="utf-8") as log:
            log.write(f"$ {' '.join(cmd)}\n")
            log.flush()
            try:
                proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log,
                                        stderr=subprocess.STDOUT, env=child_env(),
                                        creationflags=NO_WINDOW)
            except OSError as exc:
                raise _Failed(repr(exc)) from None
            with self.lock:
                self.proc = proc
            try:
                t0 = time.time()
                while proc.poll() is None:
                    if gen != self.gen:
                        proc.kill()
                        proc.wait(10)
                        raise _Aborted
                    if time.time() - t0 > STEP_TIMEOUT_S:
                        proc.kill()
                        proc.wait(10)
                        raise _Failed(f"{cmd[2:4]}: timeout {int(STEP_TIMEOUT_S)} s")
                    if watch is not None:
                        self._set("pip", mb=dir_size(watch) // 1_000_000)
                    time.sleep(1.0)
            finally:
                with self.lock:
                    self.proc = None
        self._check(gen)
        if proc.returncode != 0:
            raise _Failed(last_line(self.log) or f"exit {proc.returncode}")

    def _download(self, name: str, gen: int) -> None:
        """`.onnx.json`, потім `.onnx` — кожен спершу в `.part`, потім перейменування."""
        onnx_url, json_url = voice_urls(name)
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        for url, dest in ((json_url, self.voices_dir / f"{name}.onnx.json"),
                          (onnx_url, self.voices_dir / f"{name}.onnx")):
            part = dest.with_name(dest.name + ".part")
            try:
                self._fetch(url, part, name, gen, show=dest.suffix == ".onnx")
                os.replace(part, dest)
            except _Aborted:
                part.unlink(missing_ok=True)
                raise
            except Exception as exc:  # noqa: BLE001 — недокачане не лишаємо
                part.unlink(missing_ok=True)
                if dest.suffix == ".onnx":  # без .onnx і .json ні до чого
                    (self.voices_dir / f"{name}.onnx.json").unlink(missing_ok=True)
                raise _Failed(f"{name}: {exc!r}") from None

    def _fetch(self, url: str, part: Path, name: str, gen: int, show: bool) -> None:
        req = urllib.request.Request(url, headers={"User-Agent": "voice-mod"})
        with urllib.request.urlopen(req, timeout=30) as resp, open(part, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while True:
                self._check(gen)
                block = resp.read(256 * 1024)
                if not block:
                    break
                out.write(block)
                done += len(block)
                if show:
                    if total:
                        self._set("voice_total", name=name, mb=done // 1_000_000, total=total // 1_000_000)
                    else:
                        self._set("voice", name=name, mb=done // 1_000_000)
            if total and done != total:
                raise OSError(f"обірвано: {done}/{total} байт")

    def _probe(self, voice: str, gen: int) -> None:
        """Пробний синтез у нікуди: Piper запускається і дає звук цим голосом."""
        self._check(gen)
        text = "тест" if voice.startswith("uk") else "test"
        cmd = [str(self.python), "-m", "piper", "-m", str(self.voices_dir / f"{voice}.onnx"), "--output_raw"]
        try:
            proc = subprocess.run(cmd, input=(text + "\n").encode("utf-8"), capture_output=True,
                                  timeout=120, env=child_env(), creationflags=NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise _Failed(f"piper: {exc!r}") from None
        self._check(gen)
        if proc.returncode != 0 or not proc.stdout:
            err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
            with open(self.log, "a", encoding="utf-8") as log:
                log.write(proc.stderr.decode("utf-8", "replace"))
            raise _Failed(f"piper: exit {proc.returncode}: {err[-1][:300] if err else 'no audio'}")


# ---------------------------------------------------------------- відтворення

def _sounddevice_stream(rate: int) -> Any:
    import sounddevice as sd
    stream = sd.RawOutputStream(samplerate=rate, channels=1, dtype="int16")
    stream.start()
    return stream


class Speaker:
    """Озвучка одного блоку: Piper окремим процесом → пристрій виводу за замовчуванням.

    Синтез і відтворення — у своєму потоці, головний цикл тим часом крутиться (✖, пульс).
    `busy()` — поки звучить; `deaf_until` — до цієї миті (кінець + 0.3 с) мікрофон глухий.
    `open_stream(rate)` повертає вже запущений стрім з write/stop/abort/close.
    """

    def __init__(self, home: Path, open_stream: Callable[[int], Any] | None = None):
        self.dir = home / "tts"
        self.voices_dir = self.dir / "voices"
        self.python = tts_python(self.dir)
        self.log = home / "speak.log"
        self.open_stream = open_stream or _sounddevice_stream
        self.lock = threading.Lock()
        self.gen = 0          # росте на кожному say/stop: потік старшого покоління замовкає
        self.speaking = False
        self.proc: subprocess.Popen | None = None
        self.deaf_until = 0.0
        self.error: str | None = None

    def busy(self) -> bool:
        with self.lock:
            return self.speaking

    def take_error(self) -> str | None:
        with self.lock:
            err, self.error = self.error, None
            return err

    def say(self, text: str, voice: str) -> None:
        """Озвучити блок; те, що звучало, обривається (новий блок не стає в чергу)."""
        self.stop()
        with self.lock:
            self.gen += 1
            gen = self.gen
            self.speaking = True
        threading.Thread(target=self._run, args=(one_line(text), voice, gen), daemon=True).start()

    def stop(self) -> None:
        """Обірвати: вбити Piper; потік сам скине стрім (abort) на наступному шматку."""
        with self.lock:
            if not self.speaking:
                return
            self.gen += 1
            self.speaking = False
            self.deaf_until = time.time() + DEAF_TAIL_S
            proc, self.proc = self.proc, None
        _kill(proc)

    def _run(self, text: str, voice: str, gen: int) -> None:
        err: str | None = None
        proc: subprocess.Popen | None = None
        stream = None
        timer: threading.Timer | None = None
        timed_out = threading.Event()
        try:
            if not valid_voice(voice):
                raise ValueError(f"голос: {voice!r}")
            onnx = self.voices_dir / f"{voice}.onnx"
            rate = sample_rate(onnx)
            with open(self.log, "w", encoding="utf-8") as log:
                proc = subprocess.Popen(
                    [str(self.python), "-m", "piper", "-m", str(onnx), "--output_raw"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                    env=child_env(), creationflags=NO_WINDOW)
            with self.lock:
                if gen != self.gen:
                    _kill(proc)
                    return
                self.proc = proc

            def expire():
                timed_out.set()
                _kill(proc)

            timer = threading.Timer(SAY_TIMEOUT_S, expire)
            timer.daemon = True
            timer.start()
            try:
                proc.stdin.write((text + "\n").encode("utf-8"))
                proc.stdin.close()  # EOF — кінець висловлювання
            except OSError:
                pass  # процес уже впав — причину скаже код виходу
            rest = b""
            while True:
                chunk = proc.stdout.read1(CHUNK)
                if not chunk or gen != self.gen:
                    break
                data = rest + chunk
                n = len(data) // 2 * 2  # int16: непарний байт — до наступного шматка
                rest = data[n:]
                if not n:
                    continue
                if stream is None:
                    stream = self.open_stream(rate)
                stream.write(data[:n])
            if gen == self.gen:
                code = proc.wait(10)
                if timed_out.is_set():
                    err = f"piper: timeout {int(SAY_TIMEOUT_S)} s"
                elif code != 0:
                    err = f"piper: exit {code}: {last_line(self.log) or '?'}"
        except Exception as exc:  # noqa: BLE001 — нема пристрою, голосу, процесу: у стан error
            err = repr(exc)
        finally:
            if timer is not None:
                timer.cancel()
            _kill(proc)
            if stream is not None:
                try:
                    if gen == self.gen and err is None:
                        stream.stop()  # дограти буфер
                    else:
                        stream.abort()  # обірвали — без хвоста
                except Exception:  # noqa: BLE001
                    pass
                try:
                    stream.close()
                except Exception:  # noqa: BLE001
                    pass
            with self.lock:
                if stream is not None:
                    # Звук справді змовк лише тепер: після stop() потік ще дописував шматок
                    # (~0.2 с) і мав затримку виводу — хвіст глухоти рахуємо від цієї миті,
                    # для будь-якого покоління (новий блок глухоту лише подовжує).
                    self.deaf_until = max(self.deaf_until, time.time() + DEAF_TAIL_S)
                if gen == self.gen:
                    self.deaf_until = max(self.deaf_until, time.time() + DEAF_TAIL_S)
                    self.speaking = False
                    self.proc = None
                    if err is not None:
                        self.error = err


def _kill(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.kill()
    except OSError:
        pass
