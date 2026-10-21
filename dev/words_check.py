r"""Перевірки чистих функцій слухача (без моделей і мікрофона).

Запуск: venv-python з voice-mod (потрібен numpy):
  & "$env:USERPROFILE\.claude\voice-mod\venv\Scripts\python.exe" dev/words_check.py
"""

import importlib.util
import json
import os
import tempfile
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
cancel = L.WakeMatcher(["відміна"], prefix=False)
for s in ["запусти бота, відміна", "відміна", "Відміна!", "запусти бота. Відміно."]:
    assert cancel.split_tail(s)[0], s
assert cancel.split_tail("запусти бота, відміна") == (True, "запусти бота")
assert cancel.split_tail("відміна") == (True, "")
for s in ["це відмінний варіант", "запусти бота", "відмінити"]:
    assert not cancel.split_tail(s)[0], s
cancel_en = L.WakeMatcher(["cancel"], prefix=False)
assert cancel_en.split_tail("cancel")[0]
assert cancel_en.split_tail("run tests, cancel.") == (True, "run tests")
assert not cancel_en.split_tail("it was cancelled")[0]
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
print("words ok")
