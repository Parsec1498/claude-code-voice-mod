"""Видимі вікна консолей (до/після запуску слухача): друк hwnd, класу, заголовка."""
import ctypes
from ctypes import wintypes as w

u = ctypes.windll.user32
out = []


@ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
def cb(hwnd, _):
    if u.IsWindowVisible(hwnd):
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, cls, 256)
        if cls.value in ("ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"):
            t = ctypes.create_unicode_buffer(512)
            u.GetWindowTextW(hwnd, t, 512)
            out.append(f"{hwnd} {cls.value} {t.value}")
    return True


u.EnumWindows(cb, 0)
print("\n".join(out) or "(видимих консолей нема)")
