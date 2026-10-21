"""Обробник розпізнаної команди ДО мода: лише локальні, миттєві правки.

Тут — словник предметних слів: whisper пише «логін» там, де людина сказала
назву таска Login. Два файли: glossary.txt поруч (загальний, у коді мода) і
PERSONAL — свій, у теці керування слухача (~/.claude/voice-mod/glossary.txt);
правила свого йдуть після загальних. Чистка мови й оцінка ризику живуть
далі, у моді (модель + локальний список слів), бо їм потрібен доступ до
моделі сесії. Порожній рядок у відповіді = команду не відправляти.
"""

from __future__ import annotations

import re
from pathlib import Path

GLOSSARY = Path(__file__).with_name("glossary.txt")
PERSONAL: Path | None = None  # ставить слухач: <home>/glossary.txt

_cache: dict[Path, tuple[float, list[tuple[re.Pattern[str], str]]]] = {}


def _load() -> list[tuple[re.Pattern[str], str]]:
    rules = []
    for path in (GLOSSARY, PERSONAL):
        if path is not None:
            rules += _load_file(path)
    return rules


def _load_file(path: Path) -> list[tuple[re.Pattern[str], str]]:
    """Рядки «варіант|варіант => як писати», # — коментар.

    Перечитується, щойно файл змінився, — правиться без перезапуску слухача.
    """
    try:
        m = path.stat().st_mtime
    except OSError:
        return []
    hit = _cache.get(path)
    if hit is not None and hit[0] == m:
        return hit[1]
    rules = []
    for line in path.read_text("utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "=>" not in line:
            continue
        heard, write = (part.strip() for part in line.split("=>", 1))
        variants = [re.escape(v.strip()) for v in heard.split("|") if v.strip()]
        if variants and write:
            # Межі слова — літерні: \b у Python знає кирилицю, але «логін» не
            # має чіплятись у «логіни».
            pat = re.compile(r"(?<![\w-])(?:%s)(?![\w-])" % "|".join(variants), re.IGNORECASE)
            rules.append((pat, write))
    _cache[path] = (m, rules)
    return rules


def process(text: str) -> str:
    text = text.strip()
    for pat, write in _load():
        text = pat.sub(write, text)
    return text
