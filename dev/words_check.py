r"""Перевірки чистих функцій слухача (без моделей і мікрофона).

Запуск: venv-python з voice-mod (потрібен numpy):
  & "$env:USERPROFILE\.claude\voice-mod\venv\Scripts\python.exe" dev/words_check.py
"""

import http.server
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

path = Path(__file__).resolve().parent.parent / "listener" / "listener.py"
spec = importlib.util.spec_from_file_location("listener_mod", path)
L = importlib.util.module_from_spec(spec)
spec.loader.exec_module(L)  # main() не викликається: файл без __main__

stop = L.WakeMatcher(["роби"], prefix=False)
for s in ["запусти бота, роби", "запусти бота. Робі.", "роби", "Роби!"]:
    assert stop.split_tail(s)[0], s
for s in ["я це роблю", "він робив", "що будемо робити", "робота"]:
    assert not stop.split_tail(s)[0], s
en = L.WakeMatcher(["done"], prefix=False)
assert en.split_tail("run the tests. Done!")[0]
assert not en.split_tail("I don't")[0]
# Відомі збіги (ratio рівно 0.75, ті самі три літери): правило їх не відрізняє.
assert stop.split_tail("запусти бота, робо")[0]  # відомий збіг: «робо» ≈ «роби»
assert en.split_tail("run it. dont")[0]  # відомий збіг: «dont» ≈ «done»
# Слово скасування — те саме правило хвоста, окремий matcher.
# Точна довжина слова (exact_len): «відмінно»/«відмінна» («все відмінно») не скасовують.
cancel = L.WakeMatcher(["відміна"], prefix=False, exact_len=True)
for s in ["запусти бота, відміна", "відміна", "Відміна!", "запусти бота. Відміно.", "Відміна.", "ну відміну"]:
    assert cancel.split_tail(s)[0], s
assert cancel.split_tail("запусти бота, відміна") == (True, "запусти бота")
assert cancel.split_tail("відміна") == (True, "")
for s in ["це відмінний варіант", "запусти бота", "відмінити", "все відмінно", "вийшло відмінна",
          "відмінна", "відмінно"]:
    assert not cancel.split_tail(s)[0], s
cancel_en = L.WakeMatcher(["cancel"], prefix=False, exact_len=True)
assert cancel_en.split_tail("cancel")[0]
assert cancel_en.split_tail("cancel.")[0]
assert cancel_en.split_tail("run tests, cancel.") == (True, "run tests")
for s in ["it was cancelled", "cancels", "canceled"]:
    assert not cancel_en.split_tail(s)[0], s
# Стоп-слово лишається з допуском ±1 (exact_len вимкнено за замовчуванням).
assert L.WakeMatcher(["відміна"], prefix=False).split_tail("ні, відмна")[0]  # ±1 за замовчуванням
assert not cancel.split_tail("ні, відмна")[0]  # exact_len: на одну літеру коротше — уже ні
wake = L.WakeMatcher(["клоде", "клод"])
assert not wake.split("робі щось")[0]  # активатор правило не змінює

# Мова з control.json: невідома й порожня -> uk; типові слова беруться з LANG.
def lang_of(data: dict) -> tuple[str, str]:
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "control.json").write_text(json.dumps(data), "utf-8")
        c = L.Control(Path(d))
        c.poll()
        return c.language, c.stop


def lang_cancel(data: dict) -> str:
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "control.json").write_text(json.dumps(data), "utf-8")
        c = L.Control(Path(d))
        c.poll()
        return c.cancel


assert lang_of({"language": "de"})[0] == "uk"
assert lang_of({"language": "en"})[0] == "en"
assert lang_of({})[0] == "uk"
assert lang_of({})[1] == ""  # стоп порожній = типовий для мови
assert lang_cancel({}) == ""  # слово скасування порожнє = типове для мови
assert lang_cancel({"cancel": " стоп, скасуй "}) == "стоп, скасуй"
assert lang_cancel({"cancel": ["x"]}) == ""  # не рядок -> типове
assert L.LANG["en"]["stop"] == "done"
assert L.LANG["uk"]["cancel"] == "відміна"
assert L.LANG["en"]["cancel"] == "cancel"
assert L.LANG["uk"]["stop"] == "роби"
assert L.LANG["en"]["wake"] == "claude,clod,cloud,clawed"
for lg in ("uk", "en"):  # обидві мови мають однаковий набір ключів
    assert L.LANG[lg].keys() == L.LANG["uk"].keys(), lg

# Зміна мови піднімає version -> refresh_words перечитає слова.
with tempfile.TemporaryDirectory() as d:
    cj = Path(d) / "control.json"
    cj.write_text('{"language":"uk"}', "utf-8")
    c = L.Control(Path(d))
    c.poll()
    v = c.version
    cj.write_text('{"language":"en"}', "utf-8")
    os.utime(cj, (1, 1))  # інша mtime без залежності від роздільності годинника
    c.poll()
    assert c.language == "en" and c.version == v + 1

# Не рядок у мові — лише мова типова, решта control.json (muted) діє.
with tempfile.TemporaryDirectory() as d:
    (Path(d) / "control.json").write_text('{"language": ["en"], "muted": true}', "utf-8")
    c = L.Control(Path(d))
    c.poll()
    assert c.language == "uk" and c.muted is True

# Інша опція (сигнал) піднімає version, але не вибір -> «невдало» не знімається.
with tempfile.TemporaryDirectory() as d:
    cj = Path(d) / "control.json"
    cj.write_text('{"language":"en","model":"small","beep":"off"}', "utf-8")
    c = L.Control(Path(d))
    c.poll()
    sel, v = L.selection_of(c.language, c.wake_model, c.model), c.version
    cj.write_text('{"language":"en","model":"small","beep":"both"}', "utf-8")
    os.utime(cj, (1, 1))
    c.poll()
    assert c.version == v + 1 and L.selection_of(c.language, c.wake_model, c.model) == sel
    cj.write_text('{"language":"en","model":"medium","beep":"both"}', "utf-8")
    os.utime(cj, (2, 2))
    c.poll()
    assert L.selection_of(c.language, c.wake_model, c.model) != sel

# Вибір моделей з control.json: не рядок -> порожньо (типова).
with tempfile.TemporaryDirectory() as d:
    cj = Path(d) / "control.json"
    cj.write_text('{"wakeModel": " base ", "model": "small"}', "utf-8")
    c = L.Control(Path(d))
    c.poll()
    assert (c.wake_model, c.model) == ("base", "small")
    v = c.version
    cj.write_text('{"wakeModel": ["base"], "model": {}, "muted": true}', "utf-8")
    os.utime(cj, (1, 1))
    c.poll()
    assert (c.wake_model, c.model) == ("", "") and c.muted is True and c.version == v + 1

assert L.resolve_models("cuda", "uk", "", "") == ("small", "large-v3")
assert L.resolve_models("cpu", "uk", "", "") == ("base", "large-v3-turbo")
assert L.resolve_models("cuda", "uk", "small.en", "distil-large-v3") == ("small", "large-v3")
assert L.resolve_models("cuda", "en", "small.en", "distil-large-v3") == ("small.en", "distil-large-v3")
assert L.resolve_models("cuda", "uk", "nope", "medium") == ("small", "medium")
assert L.resolve_models("cuda", "uk", "base", "large") == ("base", "large-v3")  # псевдонім -> назва на диску
pair, new = ("small", "large-v3"), ("base", "small")
assert L.should_swap(pair, new, speaking=False, collecting=False)
assert not L.should_swap(pair, new, speaking=True, collecting=False)
assert not L.should_swap(pair, new, speaking=False, collecting=True)
assert not L.should_swap(pair, pair, speaking=False, collecting=False)


# Вибрана пара не вантажиться, а типові на тому ж пристрої — так -> винна
# пара: failed, помилка, типові на ТОМУ Ж пристрої. Не піднялись і типові —
# винен пристрій: наступний, і там знову вибір людини, без помилки про пару.
def try_load(broken):
    calls, errors, failed = [], [], set()
    chosen = ("base", "medium")

    def load(dev, names):
        calls.append((dev, names))
        if (dev, names) in broken or (dev, None) in broken:
            raise RuntimeError("oom")
        return dev, names

    def choose(dev):
        return L.default_models(dev) if chosen in failed else chosen

    try:
        got = L.load_chosen(load, ["cuda", "cpu"], choose, failed,
                            lambda dev, names, exc, ch: errors.append((dev, names, ch)))
    except RuntimeError:
        got = None
    return got, calls, errors, failed


got, calls, errors, failed = try_load({("cuda", ("base", "medium"))})
assert got == ("cuda", ("small", "large-v3")), got
assert calls == [("cuda", ("base", "medium")), ("cuda", ("small", "large-v3"))], calls
assert errors == [("cuda", ("base", "medium"), True)] and failed == {("base", "medium")}
got, calls, errors, failed = try_load({("cuda", None)})  # CUDA не піднімається зовсім
assert got == ("cpu", ("base", "medium")), got  # вибір людини — на CPU
assert calls == [("cuda", ("base", "medium")), ("cuda", ("small", "large-v3")),
                 ("cpu", ("base", "medium"))], calls
assert errors == [("cuda", ("small", "large-v3"), False)] and not failed, (errors, failed)
got, calls, errors, failed = try_load({("cuda", None), ("cpu", ("base", "medium"))})
assert got == ("cpu", ("base", "large-v3-turbo")), got  # на CPU винна вже пара
assert [e[2] for e in errors] == [False, True] and failed == {("base", "medium")}
# Виняток вибраної пари не тримає стека (а з ним і кадр із завантаженою моделлю).
excs = []


def boom(dev, names):
    if names == ("base", "medium"):
        raise RuntimeError("oom")
    return dev, names


L.load_chosen(boom, ["cuda"], lambda dev: ("base", "medium"), set(),
              lambda dev, names, exc, ch: excs.append(exc))
assert len(excs) == 1 and excs[0].__traceback__ is None and str(excs[0]) == "oom"
got, calls, errors, failed = try_load(set())  # усе гаразд — один виклик
assert got == ("cuda", ("base", "medium")) and len(calls) == 1 and not errors
got, calls, errors, failed = try_load({("cuda", None), ("cpu", None)})
assert got is None and len(calls) == 4 and not failed  # нічого не піднялось — виняток нагору
# Кнопка скасування: мітка cancelAt від мода — не налаштування (version не росте), сміття -> 0.
def cancel_at_of(data: dict) -> float:
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "control.json").write_text(json.dumps(data), "utf-8")
        c = L.Control(Path(d))
        c.poll()
        return c.cancel_at


assert cancel_at_of({"cancelAt": 1_700_000_000_000}) == 1_700_000_000_000
for junk in ("x", "123", None, [5], {"a": 1}, True):
    assert cancel_at_of({"cancelAt": junk, "beep": "off"}) == 0, junk
assert cancel_at_of({}) == 0
with tempfile.TemporaryDirectory() as d:
    cj = Path(d) / "control.json"
    cj.write_text('{"beep":"off"}', "utf-8")
    c = L.Control(Path(d))
    c.poll()
    v = c.version
    cj.write_text('{"beep":"off","cancelAt":1700000000000}', "utf-8")
    os.utime(cj, (1, 1))
    c.poll()
    assert c.cancel_at == 1_700_000_000_000 and c.version == v  # не налаштування
# Чи є нове «скасувати»: новіше за оброблене і за початок фрази, що розпізнається.
assert L.cancel_due(5, 3) and not L.cancel_due(3, 3) and not L.cancel_due(0, 0)
assert not L.cancel_due(5, 3, since=7) and L.cancel_due(8, 3, since=7)
# Що скасовується: диктовка (навіть порожня), ранній активатор, очікування команди; інакше лише мітка.
assert L.cancel_active(texts=[], armed=False, early_hit=False)
assert L.cancel_active(texts=None, armed=True, early_hit=False)
assert L.cancel_active(texts=None, armed=False, early_hit=True)
assert not L.cancel_active(texts=None, armed=False, early_hit=False)

# ---------------------------------------------------------------- озвучення (speech.py)
root = Path(__file__).resolve().parent.parent
spec_s = importlib.util.spec_from_file_location("speech_mod", root / "listener" / "speech.py")
S = importlib.util.module_from_spec(spec_s)
spec_s.loader.exec_module(S)

# Ліцензійна межа: мод Piper не імпортує, лише запускає окремим процесом.
for f in (root / "listener").glob("*.py"):
    src = f.read_text("utf-8")
    assert not re.search(r"^\s*(import|from)\s+piper\b", src, re.M), f
    assert "piper1-gpl" not in src, f

HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
assert S.voice_urls("uk_UA-mykyta-high") == (
    f"{HF}/uk/uk_UA/mykyta/high/uk_UA-mykyta-high.onnx",
    f"{HF}/uk/uk_UA/mykyta/high/uk_UA-mykyta-high.onnx.json")
assert S.voice_urls("uk_UA-lada-x_low")[0] == f"{HF}/uk/uk_UA/lada/x_low/uk_UA-lada-x_low.onnx"
assert S.voice_urls("en_US-ljspeech-medium")[1] == (
    f"{HF}/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json")
assert S.voice_urls("en_GB-cori-medium")[0] == f"{HF}/en/en_GB/cori/medium/en_GB-cori-medium.onnx"
for bad in ("", "uk_UA-mykyta", "../x-y-high", "uk_UA-my/kyta-high", "uk_UA-mykyta-ultra",
            "uk_UA-a-b-high", None, 5):
    assert not S.valid_voice(bad), bad
    try:
        S.voice_urls(bad)
        raise AssertionError(f"voice_urls({bad!r}) мала кинути ValueError")
    except ValueError:
        pass

# Типові голоси — ті самі, що в hooks/speak.ts (там вони записані як `uk: '…'`).
speak_ts = (root / "hooks" / "speak.ts").read_text("utf-8")
assert set(S.DEFAULT_VOICE) == {"uk", "en"}
for lg, name in S.DEFAULT_VOICE.items():
    assert f"{lg}: '{name}'" in speak_ts, (lg, name)
    assert S.valid_voice(name), name
for lg in S.MSG:  # тексти прогресу — однаковий набір ключів у мовах
    assert S.MSG[lg].keys() == S.MSG["uk"].keys(), lg
assert set(S.MSG) == set(L.LANG)

# Свіжість speak.json: новий seq, не старший за 60 с і за старт слухача.
NOW = 1_800_000_000_000
STARTED = NOW - 600_000
assert S.fresh_request({"seq": NOW - 1000, "at": NOW - 1000}, 0, STARTED, NOW)
assert S.fresh_request({"seq": NOW - 1000, "at": NOW - 1000, "stop": True}, NOW - 5000, STARTED, NOW)
assert S.fresh_request({"seq": NOW - 60_000, "at": NOW - 60_000}, 0, STARTED, NOW)  # рівно 60 с — ще так
assert not S.fresh_request({"seq": NOW - 61_000, "at": NOW - 61_000}, 0, STARTED, NOW)  # старий
assert not S.fresh_request({"seq": STARTED - 1, "at": STARTED - 1}, 0, STARTED, NOW + 10_000)  # до старту
assert not S.fresh_request({"seq": NOW - 1000, "at": NOW - 1000}, NOW - 1000, STARTED, NOW)  # той самий seq
assert not S.fresh_request({"seq": NOW - 2000, "at": NOW - 2000}, NOW - 1000, STARTED, NOW)  # старіший seq
for junk in ({}, {"seq": "x", "at": NOW}, {"seq": NOW, "at": None}, {"seq": True, "at": NOW},
             {"seq": [NOW], "at": NOW}):
    assert not S.fresh_request(junk, 0, STARTED, NOW), junk

# Глухота: поки звучить і ще 300 мс після — кадри мікрофона викидаються.
assert S.deaf(10.0, True, 0.0)
assert S.deaf(10.0, False, 10.2)
assert not S.deaf(10.0, False, 9.9)
assert S.DEAF_TAIL_S == 0.3
# Озвучка чекає на диктовку/команду не довше 30 с від `at`, далі блок відкидається.
assert S.speak_action(NOW, NOW - 1000, collecting=False) == "say"
assert S.speak_action(NOW, NOW - 1000, collecting=True) == "wait"
assert S.speak_action(NOW, NOW - 30_001, collecting=True) == "drop"
assert S.speak_action(NOW, NOW - 30_001, collecting=False) == "drop"
assert S.one_line(" Готово.\n\nТести  пройшли.\t") == "Готово. Тести пройшли."


# control.json: speak (типово false), голоси (рядки), ttsInstall/ttsRemove — мітки, не налаштування.
def control_of(data: dict):
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "control.json").write_text(json.dumps(data), "utf-8")
        c = L.Control(Path(d))
        c.poll()
        return c


c = control_of({})
assert (c.speak, c.speak_voice_uk, c.speak_voice_en, c.tts_install, c.tts_remove) == (False, "", "", 0, 0)
c = control_of({"speak": True, "speakVoiceUk": " uk_UA-lada-x_low ", "speakVoiceEn": "en_US-norman-medium",
                "ttsInstall": 1_700_000_000_000, "ttsRemove": 1_700_000_000_001})
assert (c.speak, c.speak_voice_uk, c.speak_voice_en) == (True, "uk_UA-lada-x_low", "en_US-norman-medium")
assert (c.tts_install, c.tts_remove) == (1_700_000_000_000, 1_700_000_000_001)
c = control_of({"speak": "yes", "speakVoiceUk": ["x"], "ttsInstall": "1", "ttsRemove": True})
assert (c.speak, c.speak_voice_uk, c.tts_install, c.tts_remove) == (False, "", 0, 0)
with tempfile.TemporaryDirectory() as d:
    cj = Path(d) / "control.json"
    cj.write_text('{"beep":"off"}', "utf-8")
    c = L.Control(Path(d))
    c.poll()
    v = c.version
    cj.write_text('{"beep":"off","ttsInstall":1700000000000,"ttsRemove":1700000000001}', "utf-8")
    os.utime(cj, (1, 1))
    c.poll()
    assert c.tts_install == 1_700_000_000_000 and c.version == v  # мітки — не налаштування

# Підставний tts\: venv без pip, де `-m piper` — фейковий скрипт (справжній Piper тут не потрібен).
FAKE_PIPER = r'''
import os, sys, time
text = sys.stdin.buffer.read()
mode = os.environ.get("FAKE_PIPER", "")
if mode == "fail":
    sys.stderr.write("boom: bad model\n")
    sys.exit(1)
n = 50 if mode == "slow" else 1
for _ in range(n):
    sys.stdout.buffer.write(b"\x01\x00\x02\x00\x03")  # непарна довжина: спікер мусить доклеїти байт
    sys.stdout.buffer.flush()
    if mode == "slow":
        time.sleep(0.1)
sys.stdout.buffer.write(b"\x04")
'''


class FakeStream:
    def __init__(self, rate: int):
        self.rate, self.data, self.closed, self.aborted, self.stopped = rate, b"", False, False, False
        self.closed_at = 0.0

    def write(self, b: bytes) -> None:
        assert len(b) % 2 == 0, len(b)
        self.data += bytes(b)

    def stop(self) -> None:
        self.stopped = True

    def abort(self) -> None:
        self.aborted = True

    def close(self) -> None:
        self.closed_at = time.time()
        self.closed = True


def wait_until(cond, sec: float = 15.0) -> bool:
    end = time.time() + sec
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


VOICE = "en_US-ljspeech-medium"
with tempfile.TemporaryDirectory() as d:
    home = Path(d)
    venv = home / "tts" / "venv"
    base = getattr(sys, "_base_executable", None) or sys.executable
    subprocess.run([base, "-m", "venv", "--without-pip", str(venv)], check=True,
                   env={k: v for k, v in os.environ.items() if k != "__PYVENV_LAUNCHER__"})
    site = venv / "Lib" / "site-packages" if os.name == "nt" else next((venv / "lib").glob("*/site-packages"))
    (site / "piper").mkdir()
    (site / "piper" / "__init__.py").write_text("", "utf-8")
    (site / "piper" / "__main__.py").write_text(FAKE_PIPER, "utf-8")
    voices = home / "tts" / "voices"
    voices.mkdir()
    (voices / f"{VOICE}.onnx").write_bytes(b"")
    (voices / f"{VOICE}.onnx.json").write_text('{"audio": {"sample_rate": 16000}}', "utf-8")
    (voices / "en_US-norman-medium.onnx.json").write_text("{}", "utf-8")  # без .onnx — не голос
    (voices / "en_US-bryce-medium.onnx.part").write_bytes(b"x")          # недокачаний — не голос

    inst = S.TtsInstaller(home, home / "tts.log")
    assert inst.voices() == [VOICE], inst.voices()
    assert not inst.installed()  # venv є, а позначки успішного встановлення — нема
    assert inst.ensure_voice(VOICE)  # уже на диску — нічого не качає
    assert inst.progress() is None and inst.take() == []

    # Нема пристрою виводу: помилка, а не вічне «говорю».
    def no_device(rate: int):
        raise OSError("no output device")

    sp = S.Speaker(home, open_stream=no_device)
    sp.say("Hello there.", VOICE)
    assert wait_until(lambda: not sp.busy()), "спікер завис без пристрою виводу"
    err = sp.take_error()
    assert err and "no output device" in err, err
    assert sp.take_error() is None

    # Звичайне відтворення: усі байти, парними шматками, частота з .onnx.json, глухота +0.3 с.
    streams: list[FakeStream] = []

    def fake_stream(rate: int) -> FakeStream:
        streams.append(FakeStream(rate))
        return streams[-1]

    sp = S.Speaker(home, open_stream=fake_stream)
    sp.say("Hello there.", VOICE)
    assert sp.busy()
    assert wait_until(lambda: not sp.busy())
    assert sp.take_error() is None
    assert len(streams) == 1 and streams[0].rate == 16000 and streams[0].data == b"\x01\x00\x02\x00\x03\x04"
    assert streams[0].stopped and streams[0].closed and not streams[0].aborted
    assert time.time() < sp.deaf_until <= time.time() + 0.31

    # stop(): процес убито, звук обірвано, busy одразу False, без помилки.
    os.environ["FAKE_PIPER"] = "slow"
    try:
        sp.say("A long one.", VOICE)
        assert wait_until(lambda: len(streams) == 2 and streams[1].data)
        t = time.time()
        sp.stop()
        assert not sp.busy() and t < sp.deaf_until <= time.time() + 0.31
        assert wait_until(lambda: streams[1].closed, 5)
        assert streams[1].aborted and len(streams[1].data) < 100
        # Хвіст глухоти — від миті, коли звук справді обірвано (стрім закрито в потоці),
        # а не від виклику stop(): останній шматок ще міг звучати після нього.
        assert wait_until(lambda: sp.deaf_until >= streams[1].closed_at + S.DEAF_TAIL_S, 2), (
            sp.deaf_until, streams[1].closed_at)
        assert sp.take_error() is None
        # Новий блок, поки звучить попередній, — попередній обірвано, новий звучить.
        sp.say("First.", VOICE)
        assert wait_until(lambda: len(streams) == 3 and streams[2].data)
        sp.say("Second.", VOICE)
        assert sp.busy()
        assert wait_until(lambda: streams[2].closed, 5) and streams[2].aborted
        assert wait_until(lambda: len(streams) == 4 and streams[3].data)
        sp.stop()
        sp.stop()  # повторний stop — нічого
        os.environ["FAKE_PIPER"] = "fail"  # Piper упав (битий голос): помилка з причиною
        sp.say("Broken.", VOICE)
        assert wait_until(lambda: not sp.busy())
        err = sp.take_error()
        assert err and "boom: bad model" in err, err
    finally:
        os.environ.pop("FAKE_PIPER", None)
    sp.say("No such voice.", "en_US-kristin-medium")  # голосу нема на диску
    assert wait_until(lambda: not sp.busy())
    assert sp.take_error()

    # Докачка голосу: та сама схема URL (тут — локальний сервер), спершу .part, потім перейменування.
    srv_root = home / "srv"
    name = "uk_UA-lada-x_low"
    rel = Path("uk/uk_UA/lada/x_low")
    (srv_root / rel).mkdir(parents=True)
    (srv_root / rel / f"{name}.onnx").write_bytes(b"o" * 300_000)
    (srv_root / rel / f"{name}.onnx.json").write_text('{"audio": {"sample_rate": 22050}}', "utf-8")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(srv_root), **kw)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    S.VOICES_URL = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        assert not inst.ensure_voice(name)  # нема — почала качати
        assert not inst.ensure_voice(name)  # уже качає — не вдруге
        assert wait_until(lambda: inst.take_voices() == [(name, None)])
        assert inst.voices() == sorted([VOICE, name]) and inst.ensure_voice(name)
        assert S.sample_rate(voices / f"{name}.onnx") == 22050
        assert not list(voices.glob(f"{name}*.part"))
        missing = "uk_UA-tetiana-high"
        assert not inst.ensure_voice(missing)
        got: list = []
        assert wait_until(lambda: bool(got.extend(inst.take_voices()) or got))
        assert got[0][0] == missing and got[0][1], got
        assert not list(voices.glob(f"{missing}*")), list(voices.iterdir())
    finally:
        srv.shutdown()
        S.VOICES_URL = HF

    # Видалення: тека tts\ зникає цілком.
    assert inst.remove() is None
    assert not (home / "tts").exists() and inst.voices() == [] and not inst.installed()
print("words ok")
