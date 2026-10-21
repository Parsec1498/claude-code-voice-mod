"""Голосовий слухач для мода `voice`: мікрофон -> слово-активатор -> команда.

Пише в stdout JSON-рядки (одна подія на рядок), мод читає їх потоком:
  {"t": "state", "state": "loading|ready|armed|transcribing|muted|error", "msg": ...}
  {"t": "ignored", "text": ...}   мова без слова-активатора (лише перший шматок)
  {"t": "part", "text": ...}      проміжна фраза диктовки (лише в історію)
  {"t": "cancelled", "text": ...} команду скасовано словом скасування (text — зібране, може бути порожнім)
  {"t": "command", "text": ..., "raw": ..., "ms": ...}
  {"t": "log", "msg": ...}

Ті самі події лягають у bus.json у --home: слухач ОДИН на машину (іменований
mutex ClaudeVoiceListener), а мод вантажать усі сесії Claude — вони читають
стан і команди з файлу, а не зі stdout чужого процесу. Другий екземпляр
виходить одразу з кодом 3.

Керування — файл control.json у --home ({"muted": true|false}): stdin у
дочірнього процесу мода закритий, тож іншого каналу назад нема.

Дві моделі свідомо: мала (small на GPU, base на CPU) слухає лише перші секунди КОЖНОЇ фрази і
шукає слово-активатор, велика (large-v3 на GPU, turbo на CPU) вмикається
тільки на фразах, що з нього почались. Інакше вся мова в кімнаті ганялась би
великою моделлю. Це типові; свої (`wakeModel`/`model` у control.json) слухач
докачує фоном і підміняє в тому ж процесі між фразами.

NPU (Intel AI Boost) перевірено 2026-10-19 через OpenVINO GenAI і відкинуто:
компіляція 252 с, текст зациклювався, initial_prompt/hotwords валять конвеєр.
"""

from __future__ import annotations

import argparse
import difflib
import functools
import gc
import json
import os
import queue
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np

RATE = 16000
CHUNK = 512  # 32 мс — розмір кадру Silero VAD на 16 кГц
CONTEXT = 64

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)


BUSY_EXIT = 3
BUS_KEEP = 40


class Bus:
    """bus.json: стан + останні події з наскрізним seq — для всіх сесій.

    seq продовжується з наявного файлу, щоб сесія, яка вже бачила події
    попереднього слухача, не прийняла нові за старі (і навпаки).
    """

    def __init__(self, home: Path):
        self.path = home / "bus.json"
        self.state, self.msg = "loading", None
        # Для списків моделей у ⚙: пристрій (типові залежать від нього) і що вже на диску.
        self.device: str | None = None
        self.models: list[str] = []
        self.events: list[dict] = []
        self.seq = 0
        try:
            old = json.loads(self.path.read_text("utf-8"))
            self.seq = int(old.get("seq") or 0)
            self.events = list(old.get("events") or [])[-BUS_KEEP:]
        except (OSError, ValueError, TypeError):
            pass
        self.flushed = 0.0
        self.lock = threading.Lock()
        # Серцебиття окремим потоком: завантаження моделей триває до 30 с, і
        # без нього сесії вважали б слухача мертвим і пробували б підняти ще.
        threading.Thread(target=self._beat_forever, daemon=True).start()

    def _beat_forever(self) -> None:
        while True:
            time.sleep(1.0)
            self.beat()

    def on_emit(self, event: dict) -> None:
        kind = event.get("t")
        if kind == "state":
            self.state, self.msg = event.get("state"), event.get("msg")
            if self.state == "error" and self.msg:
                self._add("error", text=self.msg)
        elif kind == "command":
            self._add("command", text=event.get("text"), ms=event.get("ms"))
        elif kind == "ignored":
            self._add("ignored", text=event.get("text"))
        elif kind == "part":
            self._add("part", text=event.get("text"))
        elif kind == "cancelled":
            self._add("cancelled", text=event.get("text") or "")
        elif kind == "log":
            self._add("info", text=event.get("msg"))
        self.flush()

    def _add(self, kind: str, **fields) -> None:
        self.seq += 1
        self.events.append({"seq": self.seq, "kind": kind,
                            "at": int(time.time() * 1000), **fields})
        self.events = self.events[-BUS_KEEP:]

    def beat(self) -> None:
        """Серцебиття: свіжий `at` каже сесіям, що слухач живий."""
        if time.time() - self.flushed >= 1.0:
            self.flush()

    def flush(self) -> None:
        with self.lock:
            self._flush()

    def _flush(self) -> None:
        data = {"pid": os.getpid(), "at": int(time.time() * 1000),
                "state": self.state, "msg": self.msg, "seq": self.seq,
                "device": self.device, "models": self.models, "events": self.events}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        for _ in range(10):  # читач тримає файл відкритим мить — Windows не дасть replace
            try:
                os.replace(tmp, self.path)
                break
            except PermissionError:
                time.sleep(0.02)
        self.flushed = time.time()


BUS: Bus | None = None


def emit(**event) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)
    if BUS is not None:
        BUS.on_emit(event)


_MUTEX = None


def take_mutex(name: str = r"Local\ClaudeVoiceListener") -> bool:
    """Один слухач на машину: другий бачить ERROR_ALREADY_EXISTS і йде."""
    global _MUTEX
    if os.name != "nt":
        return True
    import ctypes
    k32 = ctypes.windll.kernel32
    k32.CreateMutexW.restype = ctypes.c_void_p
    _MUTEX = k32.CreateMutexW(None, False, name)
    return k32.GetLastError() != 183


# ---------------------------------------------------------------- слово-активатор

_PUNCT = re.compile(r"[^\w\s'’-]+", re.UNICODE)


def words(text: str) -> list[str]:
    return _PUNCT.sub(" ", text.lower()).split()


class WakeMatcher:
    """Нечіткий збіг першого слова фрази зі словом-активатором.

    Whisper пише «Клоде» як завгодно: «Клод», «Клоді», «Клауд», «Claude».
    Тому — префікси плюс схожість difflib, а не рівність рядків.
    """

    def __init__(self, variants: list[str], threshold: float = 0.8, prefix: bool = True):
        self.variants = [v.strip().lower() for v in variants if v.strip()]
        self.threshold = threshold
        # Префікс годиться для активатора на ПОЧАТКУ фрази («Клоді» ≈ «Клоде»),
        # але не для стоп-слова в кінці: «роби» — префікс і «робити», а «що
        # будемо робити» не мусить відправляти команду.
        self.prefix = prefix

    def _hit(self, token: str) -> bool:
        token = token.strip("'’-")
        if len(token) < 4:  # «код», «кло» — коротке слово лише точним збігом
            return token in self.variants
        for v in self.variants:
            if self.prefix and token.startswith(v[:4]) and len(v) >= 4:
                return True
            if abs(len(token) - len(v)) > 1:
                continue  # «колода» ≈ «клод» за ratio, але довша на дві літери
            if not self.prefix and token != v and token.startswith(v):
                continue  # «робив» — інше слово, а не «роби» з помилкою
            ratio = difflib.SequenceMatcher(None, token, v).ratio()
            if ratio >= self.threshold:
                return True
            # Стоп-слово: Whisper пише «Роби» як «Робі»/«Робе» — одна літера
            # в кінці. Той самий корінь (3 літери) і ratio 0.75 це ловлять,
            # а «роблю», «робота» відсікає різниця в довжині чи корені.
            if not self.prefix and token[:3] == v[:3] and ratio >= 0.75:
                return True
        return False

    def split(self, text: str) -> tuple[bool, str]:
        """(чи почалось зі слова-активатора, решта тексту без нього)."""
        toks = words(text)
        if not toks:
            return False, ""
        n = 0
        if len(toks) > 1 and len(toks[0]) <= 3 and self._hit(toks[0] + toks[1]):
            n = 2  # «Кло де» — модель розірвала слово
        elif self._hit(toks[0]):
            n = 1
        if not n:
            return False, text.strip()
        # Відрізаємо з ОРИГІНАЛЬНОГО тексту, щоб не губити регістр і пунктуацію.
        rest = text.strip()
        for _ in range(n):
            rest = re.sub(r"^\W*[\w'’-]+", "", rest, count=1)
        return True, rest.lstrip(" ,.!?:;—-").strip()

    def split_tail(self, text: str) -> tuple[bool, str]:
        """(чи закінчилось стоп-словом, текст без нього) — дзеркало `split`."""
        toks = words(text)
        if not toks:
            return False, text.strip()
        n = 0
        if len(toks) > 1 and len(toks[-1]) <= 3 and self._hit(toks[-2] + toks[-1]):
            n = 2
        elif self._hit(toks[-1]):
            n = 1
        if not n:
            return False, text.strip()
        rest = text.strip()
        for _ in range(n):
            rest = re.sub(r"[\w'’-]+\W*$", "", rest, count=1)
        return True, rest.rstrip(" ,;:—-").strip()


# ---------------------------------------------------------------- VAD

class StreamVad:
    """Silero VAD з faster-whisper, але потоковий: стан h/c живе між кадрами.

    `SileroVADModel` із бібліотеки рахує лише цілий запис за раз, тож тут
    той самий onnx-файл, викликаний по кадру з перенесеним станом.
    """

    def __init__(self):
        import onnxruntime
        from faster_whisper.utils import get_assets_path

        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        path = os.path.join(get_assets_path(), "silero_vad_v6.onnx")
        self.session = onnxruntime.InferenceSession(
            path, providers=["CPUExecutionProvider"], sess_options=opts)
        self.reset()

    def reset(self) -> None:
        self.h = np.zeros((1, 1, 128), dtype="float32")
        self.c = np.zeros((1, 1, 128), dtype="float32")
        self.context = np.zeros(CONTEXT, dtype="float32")

    def __call__(self, frame: np.ndarray) -> float:
        x = np.concatenate([self.context, frame]).reshape(1, -1).astype("float32")
        self.context = frame[-CONTEXT:].copy()
        out, self.h, self.c = self.session.run(
            None, {"input": x, "h": self.h, "c": self.c})
        return float(np.asarray(out).reshape(-1)[-1])


class Segmenter:
    """Ріже потік кадрів на фрази: старт за VAD, кінець після тиші."""

    def __init__(self, vad: StreamVad, start=0.5, stop=0.35, silence_ms=700,
                 preroll_ms=300, min_speech_ms=250, max_ms=30000):
        self.vad = vad
        self.start, self.stop = start, stop
        ms = CHUNK * 1000 / RATE
        self.silence_frames = int(silence_ms / ms)
        self.preroll_frames = int(preroll_ms / ms)
        self.min_speech_frames = int(min_speech_ms / ms)
        self.max_frames = int(max_ms / ms)
        self.reset()

    def reset(self) -> None:
        self.pre: list[np.ndarray] = []
        self.buf: list[np.ndarray] | None = None
        self.quiet = 0
        self.speech = 0
        self.vad.reset()

    def current(self) -> np.ndarray | None:
        """Фраза, що ще звучить (для раннього пошуку активатора), або None."""
        return np.concatenate(self.buf) if self.buf else None

    @property
    def length_s(self) -> float:
        return len(self.buf) * CHUNK / RATE if self.buf else 0.0

    def push(self, frame: np.ndarray) -> np.ndarray | None:
        p = self.vad(frame)
        if self.buf is None:
            self.pre.append(frame)
            if len(self.pre) > self.preroll_frames:
                self.pre.pop(0)
            if p >= self.start:
                self.buf, self.pre = self.pre + [], []
                self.quiet, self.speech = 0, 1
            return None
        self.buf.append(frame)
        if p >= self.stop:
            self.quiet = 0
            self.speech += 1
        else:
            self.quiet += 1
        done = self.quiet >= self.silence_frames or len(self.buf) >= self.max_frames
        if not done:
            return None
        audio, speech = np.concatenate(self.buf), self.speech
        self.buf, self.quiet, self.speech = None, 0, 0
        return audio if speech >= self.min_speech_frames else None


# ---------------------------------------------------------------- мови

# Усе, що залежить від мови розпізнавання: слова за замовчуванням і тексти,
# які слухач сам пише в стан/події. Ключі в обох мов однакові (перевіряє
# words_check.py). `addressee` — слово в підказці, яке підміняється першим
# активатором користувача.
LANG: dict[str, dict[str, str]] = {
    "uk": {
        "wake": "клоде,клод,клауд,claude,лоде,лода,лоді",
        "stop": "роби",
        "cancel": "відміна",
        "prompt": ("Клоде, відкрий файл, знайди помилку, виправ її і запусти тести. "
                   "Покажи зміни, зроби коміт."),
        "addressee": "Клоде",
        "ready": "скажіть «{wake}, …»",
        "say_send": "«{stop}» — відправити, «{cancel}» — скасувати",
        "no_stop": "не почув «{stop}» за {min} хв — скасовано",
        "on": "на",
        "ready_models": "моделі готові за {sec:.1f} с: {where}",
        "no_models": "старт без моделей: мікрофон вимкнено",
        "not_loaded": "моделі ще не вантажились (мікрофон вимкнено)",
        "muted_exit_log": "мікрофон вимкнено — слухач вийшов",
        "muted_exit": "мікрофон вимкнено",
        "loading": "завантажую моделі",
        "restart": "перезапуск",
        "no_sessions": "жодної сесії Claude — вихід",
        "busy": "уже слухає інший процес",
        "start_error": "старт: {err}",
        "models_error": "моделі: {err}",
        "mic_error": "мікрофон: {err}",
        "cuda_fallback": "cuda не піднялась, беру cpu: {err}",
        "audio": "аудіо: {status}",
        "detached": "слухач відв'язано: pid {pid}",
        "swap": "перемикаю моделі: {names}",
        "download": "⬇ {name}: {gb:.1f} ГБ",
        "download_error": "завантаження {name}: {err}",
        "not_found": "після завантаження моделі нема на диску",
        "chosen_failed": "{names} не вантажиться на {device}: {err} — беру типові",
    },
    "en": {
        "wake": "claude,clod,cloud,clawed",
        "stop": "done",
        "cancel": "cancel",
        "prompt": ("Claude, open the file, find the bug, fix it and run the tests. "
                   "Show the changes, make a commit."),
        "addressee": "Claude",
        "ready": "say “{wake}, …”",
        "say_send": "“{stop}” to send, “{cancel}” to cancel",
        "no_stop": "did not hear “{stop}” in {min} min — cancelled",
        "on": "on",
        "ready_models": "models ready in {sec:.1f} s: {where}",
        "no_models": "started without models: microphone is off",
        "not_loaded": "models not loaded yet (microphone is off)",
        "muted_exit_log": "microphone is off — listener exited",
        "muted_exit": "microphone is off",
        "loading": "loading models",
        "restart": "restarting",
        "no_sessions": "no Claude sessions — exiting",
        "busy": "another process is already listening",
        "start_error": "start: {err}",
        "models_error": "models: {err}",
        "mic_error": "microphone: {err}",
        "cuda_fallback": "cuda failed to start, using cpu: {err}",
        "audio": "audio: {status}",
        "detached": "listener detached: pid {pid}",
        "swap": "switching models: {names}",
        "download": "⬇ {name}: {gb:.1f} GB",
        "download_error": "download {name}: {err}",
        "not_found": "model is not on disk after download",
        "chosen_failed": "{names} failed to load on {device}: {err} — using defaults",
    },
}


def lang_of(code: object) -> str:
    """Невідома чи порожня мова -> uk (слухач завжди має робочі слова)."""
    # Не рядок (["en"], {}) — нехешований: `in` кинув би TypeError, і poll
    # відкинув би весь control.json разом із muted.
    return code if isinstance(code, str) and code in LANG else "uk"


def text_of(value: object) -> str:
    """Рядкове поле control.json; будь-що інше — порожньо (= типове)."""
    return value.strip() if isinstance(value, str) else ""


# ---------------------------------------------------------------- моделі

# Каталог вікна ⚙ — на випадок, коли faster-whisper не імпортується (перевірки).
CATALOG = ("tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium",
           "medium.en", "large-v3-turbo", "distil-large-v3", "large-v3")
# Псевдоніми faster-whisper ведуть на ту саму теку — порівнюємо й показуємо
# справжню назву, інакше «large» вічно був би «не на диску».
ALIASES = {"large": "large-v3", "turbo": "large-v3-turbo"}


@functools.lru_cache(maxsize=1)
def known_models() -> tuple[str, ...]:
    """Назви, які faster-whisper знає сам (ключі `_MODELS`), без псевдонімів."""
    try:
        from faster_whisper.utils import _MODELS
        names = tuple(_MODELS)
    except Exception:  # noqa: BLE001 — без бібліотеки лишається каталог
        names = CATALOG
    return tuple(n for n in names if n not in ALIASES)


def default_models(device: str) -> tuple[str, str]:
    # base чув «Клоде» як «Лода»/«Лоди» і губив цілі фрази; small на GPU
    # коштує десяті секунди, на CPU — ні, там лишається base. Повний large-v3
    # на GPU: ~1.5 с на фразу і чесніша українська, ніж turbo, який на
    # підказці зациклювався; на CPU він ~4× повільніший.
    return ("small", "large-v3") if device == "cuda" else ("base", "large-v3-turbo")


def english_only(name: str) -> bool:
    return name.endswith(".en") or name.startswith("distil-")


def resolve_models(device: str, language: str, wake_model: str, model: str) -> tuple[str, str]:
    """(мала, велика), які реально вантажити для цього пристрою й мови.

    Порожня чи невідома назва -> типова. Англійська модель при іншій мові ->
    типова для того ж місця, але вибір у control.json лишається: повернеться,
    щойно мову знову перемкнуть на en.
    """
    known = known_models()
    out = []
    for name, default in zip((wake_model, model), default_models(device), strict=True):
        name = ALIASES.get(name, name) if isinstance(name, str) else ""
        if name not in known or (language != "en" and english_only(name)):
            name = default
        out.append(name)
    return out[0], out[1]


def selection_of(language: str, wake_model: str, model: str) -> tuple[str, str, str]:
    """Вибір, зміна якого знімає «невдало» (`failed`): інші налаштування
    (сигнал, слова) не мають повторювати збійну підміну чи докачку."""
    return language, wake_model, model


def should_swap(loaded: tuple[str, str], wanted: tuple[str, str],
                speaking: bool, collecting: bool) -> bool:
    """Підміна моделей — лише між фразами: посеред фрази чи диктовки вона
    забрала б 10–30 с голосу і загубила б почуте."""
    return loaded != wanted and not speaking and not collecting


def load_chosen(load, devices: list[str], choose, failed: set, on_error):
    """Вантажить моделі на першому пристрої, що піднявся.

    Вибрана пара не вантажиться (OOM, битий файл) — на ТОМУ Ж пристрої
    пробуємо типові: інакше збій вибраної великої моделі на CUDA мовчки
    переводив би на CPU з тією ж моделлю (команди в рази повільніші), а збій
    і на CPU — у вічну помилку кожні 5 с. Винною вибрану пару (`failed` і
    `on_error(..., chosen=True)`) визнаємо лише тоді, коли типові на цьому
    пристрої піднялись: упали й вони — винен пристрій (нема GPU/DLL), і на
    наступному знову пробуємо вибір людини. `on_error(dev, names, exc, chosen)`.
    """
    err: Exception | None = None
    for dev in devices:
        default, chosen = default_models(dev), choose(dev)
        chosen_exc = None
        if chosen != default:
            try:
                return load(dev, chosen)
            except Exception as exc:  # noqa: BLE001 — далі типові на цьому ж пристрої
                # Лише виняток без стека: traceback тримав би кадр із уже
                # завантаженою моделлю — зайва відеопам'ять саме тоді, коли
                # причина може бути в OOM.
                chosen_exc = exc.with_traceback(None)
        try:
            got = load(dev, default)
        except Exception as exc:  # noqa: BLE001 — винен пристрій: наступний
            err = exc
            on_error(dev, default, exc, False)
            continue
        if chosen_exc is not None:
            failed.add(chosen)
            on_error(dev, chosen, chosen_exc, True)
        return got
    assert err is not None
    raise err


def model_path(name: str) -> str | None:
    """Тека моделі в кеші HF або None, якщо її (повної) нема на диску."""
    try:
        from faster_whisper.utils import download_model
        path = download_model(name, local_files_only=True)
    except Exception:  # noqa: BLE001 — нема в кеші
        return None
    # Перерване завантаження лишає теку без ваг — така модель не готова.
    return path if os.path.exists(os.path.join(path, "model.bin")) else None


def installed_models() -> set[str]:
    return {n for n in known_models() if model_path(n)}


def hub_dir() -> Path:
    return Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ["HF_HOME"]) / "hub")


def dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


class Downloader:
    """Докачка моделей дочірнім процесом у фоні: розпізнавання тим часом іде
    старими моделями (завантаження відеопам'яті не займає).

    Окремий процес, бо мод запускає слухача з HF_HUB_OFFLINE=1, а hf_hub
    читає його лише при імпорті. Розпочате завантаження не перериваємо —
    недокачаний кеш HF гірший, ніж зайва модель на диску.
    Спільне з головним циклом — лише поля під `lock`.
    """

    def __init__(self, log: Path):
        self.log = log
        self.lock = threading.Lock()
        self.name: str | None = None   # що качається зараз
        self.size = 0                  # скільки вже на диску, байт
        self.done: list[tuple[str, str | None]] = []  # (назва, помилка) для головного циклу

    def start(self, names: list[str]) -> bool:
        with self.lock:
            if self.name is not None:
                return False
            self.name, self.size = names[0], 0
        threading.Thread(target=self._run, args=(names,), daemon=True).start()
        return True

    def progress(self) -> tuple[str, int] | None:
        with self.lock:
            return (self.name, self.size) if self.name else None

    def take(self) -> list[tuple[str, str | None]]:
        with self.lock:
            done, self.done = self.done, []
            return done

    def _run(self, names: list[str]) -> None:
        for name in names:
            with self.lock:
                self.name, self.size = name, 0
            err = self._fetch(name)
            with self.lock:
                self.done.append((name, err))
            if err:
                break
        with self.lock:
            self.name = None

    def _fetch(self, name: str) -> str | None:
        import subprocess
        try:
            from faster_whisper.utils import _MODELS
            folder = hub_dir() / ("models--" + _MODELS[name].replace("/", "--"))
        except Exception:  # noqa: BLE001 — без теки лишаємось без прогресу
            folder = None
        env = {**os.environ, "HF_HUB_OFFLINE": "0"}
        code = "import sys; from faster_whisper.utils import download_model; download_model(sys.argv[1])"
        try:
            with open(self.log, "w", encoding="utf-8") as log:
                proc = subprocess.Popen(
                    [sys.executable, "-c", code, name], env=env,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
                    creationflags=0x08000000 if os.name == "nt" else 0)  # CREATE_NO_WINDOW
                while proc.poll() is None:
                    if folder is not None:
                        size = dir_size(folder)
                        with self.lock:
                            self.size = size
                    time.sleep(1.0)
        except OSError as exc:
            return repr(exc)
        if proc.returncode == 0:
            return None
        # Остання непорожня строка stderr — зазвичай сам виняток.
        try:
            lines = [ln for ln in self.log.read_text("utf-8", "replace").splitlines() if ln.strip()]
        except OSError:
            lines = []
        return (lines[-1].strip() if lines else f"exit {proc.returncode}")[:300]


# ---------------------------------------------------------------- керування

class Control:
    def __init__(self, home: Path):
        self.path = home / "control.json"
        self.mtime = -1.0
        self.muted = False
        self.restart = 0.0  # мітка (мс) останнього «перезапусти» від сесії
        # Налаштування з вікна ⚙ мода — спільні для всіх сесій, як і muted.
        self.beep = "end"      # off | wake (після активатора) | end (після команди) | both
        self.auto_end = True   # False: команда триває до стоп-слова, тиша її не обриває
        self.wake = ""         # слова-активатори через кому; порожньо — дефолт слухача
        self.language = "uk"   # uk | en: мова розпізнавання і повідомлень слухача
        self.stop = ""         # стоп-слово(а) для режиму без автозавершення; порожньо — типове мови
        self.cancel = ""       # слово(а) скасування команди (в обох режимах); порожньо — типове мови
        self.prompt = ""       # своя підказка розпізнавачу; порожньо — загальна
        self.hotwords = ""     # свої слова-підказки; порожньо — загальні
        self.wake_model = ""   # мала модель (активатор); порожньо — типова для пристрою
        self.model = ""        # велика модель (команда); порожньо — типова для пристрою
        self.version = 0       # росте на кожній зміні налаштувань

    def poll(self) -> bool:
        """True, якщо стан змінився."""
        try:
            m = self.path.stat().st_mtime
        except OSError:
            return False
        if m == self.mtime:
            return False
        self.mtime = m
        try:
            data = json.loads(self.path.read_text("utf-8"))
            muted = bool(data.get("muted"))
            self.restart = float(data.get("restart") or 0)
            beep = data.get("beep") if data.get("beep") in ("off", "wake", "end", "both") else "end"
            auto_end = data.get("autoEnd") is not False
            wake = str(data.get("wake") or "").strip()
            stop = str(data.get("stop") or "").strip()
            cancel = text_of(data.get("cancel"))
            language = lang_of(data.get("language"))
            prompt = str(data.get("prompt") or "").strip()
            hotwords = str(data.get("hotwords") or "").strip()
            wake_model = text_of(data.get("wakeModel"))
            model = text_of(data.get("model"))
        except (OSError, ValueError, TypeError, AttributeError):
            return False
        new = (beep, auto_end, wake, stop, cancel, prompt, hotwords, language, wake_model, model)
        if new != (self.beep, self.auto_end, self.wake, self.stop, self.cancel, self.prompt,
                   self.hotwords, self.language, self.wake_model, self.model):
            (self.beep, self.auto_end, self.wake, self.stop, self.cancel, self.prompt,
             self.hotwords, self.language, self.wake_model, self.model) = new
            self.version += 1
        changed, self.muted = muted != self.muted, muted
        return changed


def sessions_alive(home: Path, now: float, keep_s: float) -> bool:
    """Чи подавала хоч одна сесія Claude ознаки життя за `keep_s` секунд.

    Кожна сесія мода раз на кілька секунд пише alive-<id>.json. Видалити файл
    API модів не дає, тож старі (сесію вбили, а не закрили) прибирає слухач.
    """
    alive = False
    for f in home.glob("alive-*.json"):
        try:
            age = now - f.stat().st_mtime
        except OSError:
            continue
        if age < keep_s:
            alive = True
        elif age > 86400:
            try:
                f.unlink()
            except OSError:
                pass
    return alive


def detach(argv: list[str], lang: str = "uk") -> int:
    """Перезапускає слухача окремим процесом і виходить одразу.

    Процес, запущений модом, гине разом із модулем (кінець сесії, hot-reload),
    а з ним і 20 с завантаження моделей. Відв'язаний — живе, доки є сесії.
    """
    import subprocess
    # NO_WINDOW дає процесу ПРИХОВАНУ консоль, і її успадковує справжній
    # python, якого запускає exe-обгортка venv. DETACHED_PROCESS тут не можна:
    # обгортка лишалась без консолі, а її дочірній створював собі нову, видиму.
    flags = 0x00000200 | 0x08000000  # NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    child = subprocess.Popen(
        [sys.executable, *argv], creationflags=flags, close_fds=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    msg = LANG[lang]["detached"].format(pid=child.pid)
    print(json.dumps({"t": "log", "msg": msg}, ensure_ascii=False), flush=True)
    return 0


# ---------------------------------------------------------------- головний цикл

def beep(on: bool, freq: int, ms: int) -> None:
    """Сигнал окремим потоком: winsound.Beep блокує, а цикл має читати кадри далі."""
    if not on:
        return

    def run():
        try:
            import winsound
            winsound.Beep(freq, ms)
        except Exception:
            pass

    threading.Thread(target=run, daemon=True).start()


def add_cuda_dlls() -> None:
    """cuBLAS/cuDNN для ctranslate2 стоять pip-колесами nvidia-* у venv, а не
    в системі: їхні теки bin Windows сама не знайде."""
    import glob
    for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True, help="тека керування (control.json)")
    # Явні --language/--wake/--prompt перекривають control.json (dev-скрипти);
    # без них слова беруться з налаштувань, а за браком — з LANG[мова].
    ap.add_argument("--wake", default=None)
    ap.add_argument("--wake-model", default=None, help="дефолт: small на cuda, base на cpu")
    ap.add_argument("--model", default=None, help="дефолт: large-v3 на cuda, turbo на cpu")
    ap.add_argument("--language", default=None, choices=sorted(LANG))
    ap.add_argument("--device", default="auto", help="auto = cuda, якщо піднялась, інакше cpu")
    ap.add_argument("--compute", default=None, help="дефолт: int8_float16 на cuda, int8 на cpu")
    ap.add_argument("--mic", type=int, default=None, help="індекс мікрофона sounddevice")
    ap.add_argument("--armed-sec", type=float, default=8.0)
    # Підказка задає whisper словник і стиль: слова звідси він пише охочіше.
    # Типова (LANG) — ЗАГАЛЬНА; свою (слова свого проєкту) людина ставить у
    # вікні ⚙ мода, вона лягає в control.json і має перевагу.
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--hotwords", default="")
    ap.add_argument("--no-beep", action="store_true")
    ap.add_argument("--file", default=None,
                    help="wav 16 кГц моно замість мікрофона (перевірка без голосу)")
    ap.add_argument("--detach", action="store_true",
                    help="запустити себе окремим процесом, що переживе сесію, і вийти")
    ap.add_argument("--muted-exit", type=float, default=60.0,
                    help="с вимкненого мікрофона, після яких слухач виходить зовсім "
                         "(мод не запускає його, доки мікрофон вимкнено)")
    ap.add_argument("--mutex", default=r"Local\ClaudeVoiceListener",
                    help="ім'я mutex; інше — лише для перевірок поруч із живим слухачем")
    ap.add_argument("--orphan-after", type=float, default=120.0,
                    help="с без жодної живої сесії Claude, після яких слухач виходить")
    args = ap.parse_args()

    if args.detach:
        return detach([a for a in sys.argv if a != "--detach"], args.language or "uk")

    home = Path(args.home)
    home.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(home / "hf"))

    control = Control(home)
    control.poll()

    def lang() -> str:
        # Мова береться на кожному виклику: зміна в ⚙ діє з наступної фрази
        # без перезавантаження моделей (whisper мовозалежний лише параметром).
        return args.language or control.language

    def tr(key: str, **kw) -> str:
        return LANG[lang()][key].format(**kw)

    global BUS
    if not args.file and not take_mutex(args.mutex):  # файл — перевірка, мікрофона не бере
        emit(t="state", state="busy", msg=tr("busy"))
        return BUSY_EXIT
    BUS = Bus(home)

    emit(t="state", state="loading", msg=tr("loading"))
    t0 = time.time()
    error_until = 0.0  # до цієї миті рядок показує помилку, а не «готовий»
    try:
        import sounddevice as sd
        from faster_whisper import WhisperModel

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import processor
        processor.PERSONAL = home / "glossary.txt"  # свій словник — поза кодом мода

        threads = max(1, (os.cpu_count() or 4) // 2)

        def wanted(dev: str) -> tuple[str, str]:
            # Явні --wake-model/--model (dev-скрипти) перекривають вибір у ⚙.
            return resolve_models(dev, lang(), args.wake_model or control.wake_model,
                                  args.model or control.model)

        # Що вже на диску — для bus.json і щоб не вантажити відсутню модель.
        installed = installed_models()
        # Вибір (пара чи назва), що не завантажився чи не вантажився в пам'ять.
        failed: set = set()

        def choose(dev: str) -> tuple[str, str]:
            """Вибір із ⚙, але без того, чого ще нема на диску чи що вже не вантажилось."""
            pick = wanted(dev)
            names = tuple(d if n not in installed or n in failed else n
                          for n, d in zip(pick, default_models(dev), strict=True))
            return default_models(dev) if pick in failed or names in failed else names

        def load(dev: str, names: tuple[str, str]):
            compute = args.compute or ("int8_float16" if dev == "cuda" else "int8")
            wake_name, name = names
            wake = WhisperModel(wake_name, device=dev,
                                compute_type=compute, cpu_threads=threads)
            main_ = WhisperModel(name, device=dev,
                                 compute_type=compute, cpu_threads=threads)
            # Прогрів: перший прохід на cuda ~10 с (і саме тут випливає брак
            # DLL cuDNN), тож платимо його зараз, а не на першій команді.
            silence = np.zeros(RATE, dtype=np.float32)
            for m in (wake, main_):
                list(m.transcribe(silence, language=lang())[0])
            return (wake, main_, (wake_name, name), dev,
                    f"{wake_name}+{name} {tr('on')} {dev} ({compute})")

        def load_models():
            nonlocal error_until
            devices = {"auto": ["cuda", "cpu"], "cuda": ["cuda"]}.get(args.device, ["cpu"])
            if args.device == "auto" and no_gpu:
                devices = ["cpu"]  # GPU точно нема — не платимо за спробу cuda
            hit = False

            def on_error(dev, names, exc, chosen):
                nonlocal hit
                if chosen:
                    # Вибір у control.json лишається: зміниться — спробуємо знову.
                    hit = True
                    emit(t="state", state="error", msg=tr(
                        "chosen_failed", names="+".join(names), device=dev, err=repr(exc)))
                elif dev == "cuda" and len(devices) > 1:  # нема GPU/DLL: працюємо на CPU
                    emit(t="log", msg=tr("cuda_fallback", err=repr(exc)))

            got = load_chosen(load, devices, choose, failed, on_error)
            if hit:
                error_until = time.time() + 5  # причину видно й після завантаження типових
            return got

        # Пристрій до завантаження — за наявністю GPU: ⚙ показує типові моделі
        # і при вимкненому мікрофоні. Після завантаження — справжній.
        device = "cpu"
        no_gpu = False  # лише коли ctranslate2 ТОЧНО сказав «0 пристроїв»
        if args.device in ("auto", "cuda"):
            add_cuda_dlls()
            try:
                import ctranslate2
                if ctranslate2.get_cuda_device_count() > 0:
                    device = "cuda"
                else:
                    no_gpu = True
            except Exception:  # noqa: BLE001 — не знаємо: cuda все одно спробуємо
                pass
        BUS.device, BUS.models = device, sorted(installed)

        # Мікрофон вимкнений ще до старту — моделі вантажимо, лише коли ввімкнуть.
        wake_model = model = None
        loaded: tuple[str, str] = ("", "")
        where = tr("not_loaded")
        if not control.muted:
            wake_model, model, loaded, device, where = load_models()
            BUS.device = device
        vad = StreamVad()
    except Exception as exc:  # noqa: BLE001 — будь-яка поломка старту йде в панель
        emit(t="state", state="error", msg=tr("start_error", err=repr(exc)))
        return 2
    emit(t="log", msg=tr("ready_models", sec=time.time() - t0, where=where) if model is not None
         else tr("no_models"))

    seg = Segmenter(vad)
    frames: queue.Queue[np.ndarray] = queue.Queue()

    # Слова й підказки — з налаштувань (вікно ⚙ мода), перечитуються на льоту.
    words_ver = -1
    matcher = stopper = canceller = None
    wake_word = stop_word = cancel_word = prompt = hotwords = ""

    def refresh_words():
        nonlocal words_ver, matcher, stopper, canceller, wake_word, stop_word, cancel_word
        nonlocal prompt, hotwords
        if words_ver == control.version and matcher is not None:
            return
        words_ver = control.version
        lg = LANG[lang()]
        wake_list = [w for w in (args.wake or control.wake or lg["wake"]).split(",") if w.strip()]
        matcher = WakeMatcher(wake_list)
        wake_word = wake_list[0].strip().capitalize()
        stop_list = [w for w in (control.stop or lg["stop"]).split(",") if w.strip()]
        stopper = WakeMatcher(stop_list, prefix=False)
        stop_word = stop_list[0].strip().capitalize()
        # Слово скасування — те саме правило хвоста, що й у стоп-слова, окремий matcher.
        cancel_list = [w for w in (control.cancel or lg["cancel"]).split(",") if w.strip()]
        canceller = WakeMatcher(cancel_list, prefix=False)
        cancel_word = cancel_list[0].strip().capitalize()
        prompt = (args.prompt or control.prompt or lg["prompt"]).replace(lg["addressee"], wake_word)
        hotwords = control.hotwords or args.hotwords
        if not control.auto_end:
            prompt += f" {stop_word}."  # whisper охочіше пише слово, яке бачив

    def cue(kind: str) -> None:
        """Сигнал: start — почуто активатор, end — команду завершено."""
        modes = ("wake", "both") if kind == "start" else ("end", "both")
        if control.beep in modes:
            beep(not args.no_beep, 880 if kind == "start" else 1320, 90 if kind == "start" else 80)

    def on_audio(indata, _frames, _time, status):
        if status:
            emit(t="log", msg=tr("audio", status=status))
        frames.put(indata[:, 0].copy())

    def transcribe(m, audio, **kw) -> str:
        segs, _info = m.transcribe(
            audio, language=lang(), condition_on_previous_text=False,
            vad_filter=False, without_timestamps=True, **kw)
        return " ".join(s.text.strip() for s in segs).strip()

    class FileStream:
        """Файл замість мікрофона: усі кадри одразу в чергу + 2 с тиші."""

        def __init__(self, path: str):
            import wave
            with wave.open(path, "rb") as w:
                if w.getframerate() != RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
                    raise ValueError("потрібен wav 16 кГц, моно, 16 біт")
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
            audio = np.concatenate([pcm.astype("float32") / 32768.0,
                                    np.zeros(RATE * 2, dtype="float32")])
            audio = audio[: len(audio) // CHUNK * CHUNK]
            for f in audio.reshape(-1, CHUNK):
                frames.put(f)

        def close(self):
            pass

    def open_stream():
        if args.file:
            return FileStream(args.file)
        s = sd.InputStream(samplerate=RATE, channels=1, dtype="float32",
                           blocksize=CHUNK, device=args.mic, callback=on_audio)
        s.start()
        return s

    stream = None
    armed_until = 0.0
    last_state = None
    born = time.time() * 1000
    muted_since: float | None = None
    last_alive_check = time.time()
    # Ранній активатор: фразу, що ще звучить, мала модель перевіряє на цих
    # позначках довжини. Знайшла — сигнал (режим «одразу»), позначка, щоб
    # наприкінці фрази не перевіряти вдруге, і живий текст у рядку.
    # Мала модель на GPU коштує ~130 мс на 0.5–1.2 с звуку і на коротких
    # шматках чує активатор НАДІЙНІШЕ, ніж на 2 с (там губила «Claude»);
    # на CPU прохід у рази дорожчий — там рідше.
    EARLY_GPU = (0.5, 0.8, 1.1, 1.5, 2.0, 2.5)
    EARLY_CPU = (1.0, 1.6, 2.4)
    early_next = 0
    early_hit = False
    # Стороння мова: коли мала модель двічі поспіль дала ≥3 слова, а перше —
    # не активатор, фразу далі не ганяємо (ні ранніми перевірками, ні в кінці).
    early_text = ""
    early_misses = 0
    rejected = False
    # Стоп-слово (і слово скасування) діє лише в кінці фрази, тобто після повних 700 мс тиші:
    # перевірка вже на 160 мс паузи (2026-10-20) обривала команду, щойно
    # слово траплялось ПОСЕРЕД речення, — власник її зняв. Швидким лишився
    # лише випадок, коли фраза — саме лише стоп-слово чи слово скасування:
    # тоді без великої моделі.
    BARE_STOP_MAX_S = 1.5
    # Живий текст: поки звучить фраза-команда, мала модель раз на LIVE_EVERY_S
    # мови переписує її чернетку в рядок (велика — лише на кінці фрази).
    LIVE_EVERY_S = 1.0
    LIVE_WINDOW_S = 20.0
    live_next = 0.0
    # Режим без автозавершення: КОЖНА фраза після активатора розпізнається
    # великою моделлю одразу, щойно закінчилась, а текст копиться, доки
    # остання не закінчиться стоп-словом. Раніше після «Роби» велика модель
    # переганяла весь звук разом — 5–12 с на довгій команді; тепер лише
    # останню коротку фразу. Стеля — COLLECT_MAX_S.
    COLLECT_MAX_S = 300.0
    texts: list[str] | None = None
    raws: list[str] = []
    collect_since = 0.0
    # Вибір моделей у ⚙: відсутню докачує фоновий потік, підміна — між фразами.
    # Невдале завантаження чи підміну не повторюємо, доки вибір не зміниться
    # (інакше слухач крутився б у помилці кожні 5 с).
    downloader = Downloader(home / "download.log")
    failed_sel = selection_of(control.language, control.wake_model, control.model)

    def state(name: str, msg: str | None = None):
        nonlocal last_state
        if (name, msg) != last_state:
            last_state = (name, msg)
            emit(t="state", state=name, msg=msg)

    def tail(text: str, n: int = 160) -> str:
        text = " ".join(text.split())
        return text if len(text) <= n else "…" + text[-n:]

    def show_live(draft: str = "") -> None:
        done = " ".join(texts or [])
        live = tail(f"{done} {draft}".strip())
        hint = tr("say_send", stop=stop_word, cancel=cancel_word) if texts is not None else None
        state("armed", live or hint or None)

    def stop_collect():
        nonlocal texts
        texts = None

    def big(audio: np.ndarray, context: str = "", wake: bool = False) -> str:
        # Попередні фрази тієї ж команди — у підказку: whisper тримає стиль і слова.
        p = f"{prompt} {context[-200:]}".strip() if context else prompt
        # Звертання на початку фрази large-v3 викидає («Claude, start…» → «Start…»)
        # за будь-якої підказки; повертає його лише hotword — як у малої моделі.
        hw = f"{wake_word} {hotwords}".strip() if wake else hotwords
        return transcribe(model, audio, beam_size=5, initial_prompt=p, hotwords=hw or None)

    def swap(names: tuple[str, str]) -> str | None:
        """Підміна моделей у тому ж процесі; повертає причину невдачі або None."""
        nonlocal wake_model, model, loaded, device, where
        state("loading", tr("swap", names="+".join(names)))
        t0, prev = time.time(), loaded
        # Спершу звільнити старі, потім вантажити нові: дві великі моделі
        # разом не влазять у 8 ГБ відеопам'яті.
        wake_model = model = None
        gc.collect()
        err = None
        try:
            wake_model, model, loaded, device, where = load(device, names)
            emit(t="log", msg=tr("ready_models", sec=time.time() - t0, where=where))
        except Exception as exc:  # noqa: BLE001 — назад до попередніх моделей
            err = tr("models_error", err=repr(exc))
        if err is not None:
            state("error", err)  # одразу: повернення до попередніх — ще 10–30 с
            wake_model = model = None
            gc.collect()
            try:
                wake_model, model, loaded, device, where = load(device, prev)
            except Exception:  # noqa: BLE001 — model=None: головний цикл вантажить типові
                wake_model = model = None
        if not args.file:
            # Звук, що накопичився за 10–30 с завантаження, — вже не команда.
            while not frames.empty():
                frames.get_nowait()
        seg.reset()
        return err

    def send(text: str, raw: str, started: float, cued: bool = False) -> None:
        ms = int((time.time() - started) * 1000)
        final = processor.process(text)
        if final:
            if not cued:
                cue("end")
            emit(t="command", text=final, raw=raw, ms=ms)
        else:
            emit(t="ignored", text=raw)

    def cancel_command(text: str, cued: bool = False) -> None:
        """Скасування: у чат нічого не йде, звучить сигнал кінця, текст зібраного — лише в історію."""
        if not cued:
            cue("end")
        emit(t="cancelled", text=text)

    def finish_phrase(audio: np.ndarray, started: float, wake_known: bool, cued: bool = False) -> None:
        """Фраза з активатором (або після голого «Клоде») → команда чи початок диктування."""
        nonlocal armed_until, texts, raws, collect_since
        state("transcribing", tail(f"{' '.join(texts or [])}"))
        raw = big(audio, wake=True)
        hit, text = matcher.split(raw)
        if not hit and not wake_known:
            emit(t="ignored", text=raw)  # мала модель почула активатор, велика — ні
            return
        if not hit:
            text = raw
        # Слово скасування — раніше за стоп-слово: «… роби відміна» = скасування.
        has_cancel, rest = canceller.split_tail(text)
        if has_cancel:
            cancel_command(rest, cued)
            return
        if not control.auto_end:
            has_stop, rest = stopper.split_tail(text)
            if has_stop:
                send(rest, raw, started, cued)
            else:
                texts, raws, collect_since = ([text] if text else []), [raw], time.time()
                emit(t="part", text=raw)  # перша фраза диктовки — в історію
                show_live()
            return
        if not text:
            # Голе «Клоде» — чекаємо команду наступною фразою.
            armed_until = time.time() + args.armed_sec
            if not early_hit:
                cue("start")
            return
        send(text, raw, started)

    def collect_phrase(audio: np.ndarray, started: float, bare: str = "") -> None:
        """Чергова фраза диктування: велика модель одразу; стоп-слово — відправка,
        слово скасування — відкинути зібране. `bare` — фраза саме лише «stop» чи «cancel»
        (сигнал уже пролунав)."""
        nonlocal raws
        if bare:
            # Фраза — саме лише «Роби»/«Відміна»: решту вже розпізнано, велика модель не потрібна.
            whole, whole_raw = " ".join(texts or []), " ".join(raws)
            stop_collect()
            if bare == "cancel":
                cancel_command(whole, cued=True)
            else:
                send(whole, whole_raw, started, cued=True)
            return
        state("transcribing", tail(" ".join(texts or [])))
        raw = big(audio, " ".join(texts or []))
        raws.append(raw)
        emit(t="part", text=raw)  # проміжна фраза диктовки — в історію
        has_cancel, rest = canceller.split_tail(raw)
        if has_cancel:
            whole = " ".join([*texts, rest] if rest else texts)
            stop_collect()
            cancel_command(whole)
            return
        has_stop, rest = stopper.split_tail(raw)
        if rest:
            texts.append(rest)
        if has_stop:
            whole, whole_raw = " ".join(texts), " ".join(raws)
            stop_collect()
            send(whole, whole_raw, started)
        else:
            show_live()

    try:
        while True:
            control.poll()
            refresh_words()
            if BUS is not None:
                BUS.beat()
            if control.restart > born:
                state("off", tr("restart"))
                return 0  # сесії побачать «off» і піднімуть нового
            now = time.time()
            if not args.file and now - last_alive_check > 10:
                last_alive_check = now
                if not sessions_alive(home, now, args.orphan_after):
                    state("off", tr("no_sessions"))
                    return 0
            if control.muted:
                if stream is not None:
                    stream.close()
                    stream = None
                    seg.reset()
                    stop_collect()
                    while not frames.empty():
                        frames.get_nowait()
                muted_since = muted_since or now
                if not args.file and now - muted_since > args.muted_exit:
                    # Хвилина запасу — на випадкове натискання; далі процес не
                    # тримає ні ~2.4 ГБ відеопам'яті, ні пам'яті взагалі. Увімкнуть
                    # мікрофон — мод підніме слухача заново (~20 с моделі).
                    emit(t="log", msg=tr("muted_exit_log"))
                    state("off", tr("muted_exit"))
                    return 0
                state("muted")
                time.sleep(0.3)
                continue
            muted_since = None
            if model is None:
                state("loading", tr("loading"))
                t0 = time.time()
                try:
                    wake_model, model, loaded, device, where = load_models()
                except Exception as exc:  # noqa: BLE001
                    state("error", tr("models_error", err=repr(exc)))
                    time.sleep(5)
                    continue
                BUS.device = device
                emit(t="log", msg=tr("ready_models", sec=time.time() - t0, where=where))
            sel = selection_of(control.language, control.wake_model, control.model)
            if sel != failed_sel:
                failed.clear()  # той самий об'єкт: його бачить і choose()
                failed_sel = sel
            for name, err in downloader.take():
                if err is None:
                    installed = installed_models()
                    BUS.models = sorted(installed)
                    BUS.flush()
                    if name not in installed:
                        err = tr("not_found")
                if err is not None:
                    failed.add(name)
                    error_until = time.time() + 5
                    state("error", tr("download_error", name=name, err=err))
            want = wanted(device)
            if want != loaded and want not in failed:
                missing = [n for n in dict.fromkeys(want) if n not in installed]
                if missing:
                    if not failed.intersection(missing):
                        downloader.start(missing)  # уже качає — дочекається, тоді наступна
                elif should_swap(loaded, want, seg.buf is not None or time.time() < armed_until,
                                 texts is not None):
                    err = swap(want)
                    if err is not None:
                        failed.add(want)
                        error_until = time.time() + 5
                        state("error", err)
                    continue  # моделі (а з ними й час) інші — цикл спочатку
            if stream is None:
                try:
                    stream = open_stream()
                except Exception as exc:  # noqa: BLE001
                    state("error", tr("mic_error", err=exc))
                    time.sleep(3)
                    continue
            if texts is not None and control.auto_end:
                stop_collect()  # автозавершення ввімкнули посеред диктування
            if texts is not None and now - collect_since > COLLECT_MAX_S:
                emit(t="ignored",
                     text=tr("no_stop", stop=stop_word, min=int(COLLECT_MAX_S // 60)))
                stop_collect()
            armed = time.time() < armed_until
            speaking = seg.buf is not None
            if texts is None and not speaking and not early_hit and time.time() >= error_until:
                got = downloader.progress()
                hint = (tr("download", name=got[0], gb=got[1] / 1e9) if got
                        else tr("ready", wake=wake_word))
                state("armed" if armed else "ready", None if armed else hint)
            try:
                frame = frames.get(timeout=0.3)
            except queue.Empty:
                if args.file:
                    return 0  # файл дочитано
                continue
            was_quiet = seg.buf is None
            audio = seg.push(frame)
            if was_quiet and seg.buf is not None:
                # Почалась нова фраза.
                early_next, early_hit, live_next = 0, False, LIVE_EVERY_S
                early_text, early_misses, rejected = "", 0, False

            if audio is None and seg.buf is not None:
                commanding = texts is not None or armed or early_hit
                # Ранній активатор: фраза ще звучить, а команди ще нема.
                early_at = EARLY_GPU if "cuda" in where else EARLY_CPU
                if (not commanding and not rejected and early_next < len(early_at)
                        and seg.length_s >= early_at[early_next]):
                    early_next += 1
                    partial = seg.current()
                    if partial is not None:
                        first = transcribe(wake_model, partial[: int(RATE * 2.5)], beam_size=1,
                                           hotwords=wake_word)
                        if matcher.split(first)[0]:
                            early_hit = commanding = True
                            cue("start")
                            emit(t="wake", early=True, at=round(seg.length_s, 2))
                            show_live(matcher.split(first)[1])
                            live_next = seg.length_s + LIVE_EVERY_S
                        elif first:
                            early_text = first
                            early_misses = early_misses + 1 if len(words(first)) >= 3 else 0
                            rejected = early_misses >= 2
                # Живий текст фрази-команди.
                if commanding and seg.length_s >= live_next:
                    live_next = seg.length_s + LIVE_EVERY_S
                    partial = seg.current()
                    if partial is not None:
                        draft = transcribe(wake_model, partial[-int(RATE * LIVE_WINDOW_S):],
                                           beam_size=1, hotwords=wake_word)
                        hit, rest = matcher.split(draft)
                        show_live(rest if hit else draft)
            if audio is None:
                continue

            started = time.time()
            if texts is not None:
                bare = ""
                if len(audio) <= RATE * BARE_STOP_MAX_S:
                    heard = transcribe(wake_model, audio, beam_size=1,
                                       hotwords=f"{stop_word} {cancel_word}")
                    # Скасування перевіряється першим, як і в повній фразі.
                    for kind, m in (("cancel", canceller), ("stop", stopper)):
                        has, before = m.split_tail(heard)
                        if has and not before.strip(" .,!?"):
                            bare = kind
                            break
                    if bare:
                        emit(t="part", text=heard)
                        cue("end")
                collect_phrase(audio, started, bare)
                continue
            if armed:
                armed_until = 0.0
                finish_phrase(audio, started, wake_known=True)
                continue
            early_all = len(EARLY_GPU if "cuda" in where else EARLY_CPU)
            if not early_hit and (rejected or early_next >= early_all):
                # Початок фрази мала модель уже бачила на ранніх перевірках —
                # кінцева перевірка ганяла б той самий звук удруге.
                if early_text:
                    emit(t="ignored", text=early_text)
                continue
            if not early_hit:
                # Спершу короткий початок (так мала модель чує активатор надійніше),
                # потім довший — якщо перед «Клоде» щось було.
                first = transcribe(wake_model, audio[: int(RATE * 1.2)], beam_size=1,
                                   hotwords=wake_word)
                if not matcher.split(first)[0]:
                    first = transcribe(wake_model, audio[: int(RATE * 2.5)], beam_size=1,
                                       hotwords=wake_word)
                if not matcher.split(first)[0]:
                    if first:
                        emit(t="ignored", text=first)
                    continue
                early_hit = True  # фраза коротша за ранню перевірку — сигнал тепер
                cue("start")
            finish_phrase(audio, started, wake_known=False)
            early_hit = False
    except KeyboardInterrupt:
        return 0
    finally:
        if stream is not None:
            stream.close()
        if BUS is not None:
            BUS.state, BUS.msg = "off", None
            BUS.flush()


if __name__ == "__main__":
    sys.exit(main())
