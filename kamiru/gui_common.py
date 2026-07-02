"""Utilidades compartidas de la interfaz (paleta, estilos, base de fases).

Cada "fase" de la app (Generar hojas / Procesar escaneos / Calibración /
Video final) es un Frame independiente con su propio hilo de trabajo, su
cola de mensajes, su log y su barra de progreso, para que ninguna fase
congele a las demás.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import colorchooser, ttk

PAD = 10

# Paleta de la interfaz (look limpio y cálido, con verde como acento 💚).
PALETTE = {
    "bg": "#F3F5F7",          # fondo general
    "card": "#FFFFFF",        # campos / pestaña activa
    "text": "#243038",        # texto principal
    "muted": "#6B7B88",       # texto secundario
    "accent": "#1FA37A",      # verde principal
    "accent_dark": "#15795A",
    "accent_soft": "#A9CEC2",  # acento atenuado (botón deshabilitado)
    "accent_text": "#FFFFFF",
    "border": "#D5DCE2",
    "tab_off": "#E5EBEF",      # pestaña inactiva
    "trough": "#E3E8EC",       # canal de la barra de progreso
    "cyan": "#17315C",         # azul de Prusia (acentos del modo cianotipia)
    "log_bg": "#FBFCFD",
}


def build_style(root: tk.Tk):
    """Aplica el tema visual a toda la app."""
    import tkinter.font as tkfont
    p = PALETTE

    # Fuentes base un poco más grandes (sin encoger las de macOS, que ya
    # parten de un tamaño mayor).
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
        try:
            f = tkfont.nametofont(name)
            sz = f.cget("size")
            if sz < 0:  # tamaño en píxeles -> pasamos a puntos aprox.
                sz = max(10, int(round(abs(sz) * 0.75)))
            f.configure(size=max(sz, 13) + 1)
        except tk.TclError:
            pass

    root.configure(bg=p["bg"])
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass

    style.configure(".", background=p["bg"], foreground=p["text"])
    style.configure("TFrame", background=p["bg"])
    style.configure("TLabel", background=p["bg"], foreground=p["text"])
    style.configure("Header.TLabel", font=("", 25, "bold"),
                    foreground=p["accent_dark"])
    style.configure("Sub.TLabel", foreground=p["muted"])
    style.configure("Info.TLabel", foreground=p["accent_dark"], font=("", 13, "bold"))
    style.configure("Warn.TLabel", foreground="#B4562F", font=("", 13, "bold"))

    style.configure("TLabelframe", background=p["bg"], bordercolor=p["border"],
                    relief="solid", borderwidth=1)
    style.configure("TLabelframe.Label", background=p["bg"],
                    foreground=p["accent_dark"], font=("", 14, "bold"))

    for w in ("TCheckbutton", "TRadiobutton"):
        style.configure(w, background=p["bg"], foreground=p["text"])
        style.map(w, background=[("active", p["bg"])],
                  foreground=[("disabled", p["muted"])])

    # Botones
    style.configure("TButton", padding=8, background=p["card"],
                    foreground=p["text"], bordercolor=p["border"],
                    focuscolor=p["accent"])
    style.map("TButton",
              background=[("active", p["tab_off"]), ("pressed", p["tab_off"])],
              bordercolor=[("focus", p["accent"])])
    style.configure("Accent.TButton", font=("", 15, "bold"), padding=11,
                    background=p["accent"], foreground=p["accent_text"],
                    bordercolor=p["accent"])
    style.map("Accent.TButton",
              background=[("active", p["accent_dark"]),
                          ("pressed", p["accent_dark"]),
                          ("disabled", p["accent_soft"])],
              foreground=[("disabled", "#EEF6F2")])
    style.configure("Cyan.TButton", font=("", 15, "bold"), padding=11,
                    background=p["cyan"], foreground="#FFFFFF",
                    bordercolor=p["cyan"])
    style.map("Cyan.TButton",
              background=[("active", "#0F2140"), ("pressed", "#0F2140"),
                          ("disabled", "#9FB0CB")])

    # Pestañas
    style.configure("TNotebook", background=p["bg"], bordercolor=p["border"],
                    tabmargins=(4, 4, 4, 0))
    style.configure("TNotebook.Tab", padding=(15, 9),
                    background=p["tab_off"], foreground=p["muted"])
    style.map("TNotebook.Tab",
              background=[("selected", p["card"])],
              foreground=[("selected", p["accent_dark"])],
              expand=[("selected", (1, 1, 1, 0))])
    # Pestañas de fase (nivel superior), un poco más grandes.
    style.configure("Phase.TNotebook", background=p["bg"],
                    bordercolor=p["border"], tabmargins=(4, 6, 4, 0))
    style.configure("Phase.TNotebook.Tab", padding=(18, 10),
                    font=("", 14, "bold"),
                    background=p["tab_off"], foreground=p["muted"])
    style.map("Phase.TNotebook.Tab",
              background=[("selected", p["card"])],
              foreground=[("selected", p["accent_dark"])])

    # Campos de entrada
    style.configure("TEntry", fieldbackground=p["card"], bordercolor=p["border"],
                    padding=4)
    style.configure("TSpinbox", fieldbackground=p["card"], bordercolor=p["border"],
                    arrowsize=14, padding=3)
    style.configure("TCombobox", fieldbackground=p["card"], bordercolor=p["border"],
                    padding=3)
    style.map("TCombobox", fieldbackground=[("readonly", p["card"])])

    # Barra de progreso
    style.configure("TProgressbar", background=p["accent"], troughcolor=p["trough"],
                    bordercolor=p["border"], lightcolor=p["accent"],
                    darkcolor=p["accent"])


class PhaseFrame(ttk.Frame):
    """Base para las fases: hilo de trabajo + cola + log + progreso."""

    def __init__(self, master, app):
        super().__init__(master, padding=PAD)
        self.app = app          # referencia a la ventana principal
        self.queue: "queue.Queue" = queue.Queue()
        self.worker = None
        self._cancel = False

    # ------------------------------------------------------------- helpers
    def section(self, parent, title):
        lf = ttk.LabelFrame(parent, text=title, padding=PAD)
        lf.pack(fill="x", padx=PAD, pady=(PAD, 0))
        lf.columnconfigure(1, weight=1)
        return lf

    def color_picker(self, parent, var, row, col):
        box = ttk.Frame(parent)
        box.grid(row=row, column=col, sticky="w", padx=4, pady=(6, 0))
        swatch = tk.Label(box, width=3, relief="solid", borderwidth=1, bg=var.get())
        swatch.pack(side="left")

        def choose():
            c = colorchooser.askcolor(color=var.get(), title="Elegir color")
            if c and c[1]:
                var.set(c[1])
                swatch.configure(bg=c[1])
        var.trace_add("write", lambda *_: self._safe_bg(swatch, var))
        ttk.Button(box, text="Cambiar", command=choose, width=8).pack(
            side="left", padx=(4, 0))
        return box

    @staticmethod
    def _safe_bg(widget, var):
        try:
            widget.configure(bg=var.get())
        except tk.TclError:
            pass

    @staticmethod
    def to_int(var, default):
        try:
            return int(float(var.get()))
        except (tk.TclError, ValueError):
            return default

    @staticmethod
    def to_float(var, default):
        try:
            return float(var.get())
        except (tk.TclError, ValueError):
            return default

    # --------------------------------------------------------------- log
    def build_log(self, parent, height=9):
        p = PALETTE
        frame = ttk.Frame(parent)
        frame.pack(fill="both", expand=True, padx=PAD, pady=(PAD, 0))
        self.log_text = tk.Text(frame, height=height, bg=p["log_bg"],
                                fg=p["text"], relief="solid", borderwidth=1,
                                highlightthickness=0, wrap="word",
                                font=("", 12), state="disabled")
        sb = ttk.Scrollbar(frame, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log_text.pack(side="left", fill="both", expand=True)
        return self.log_text

    def log(self, text):
        """Escribe en el log (seguro desde cualquier hilo, vía la cola)."""
        self.queue.put(("log", text))

    def _append_log(self, text):
        if not hasattr(self, "log_text"):
            return
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text.rstrip() + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    # ------------------------------------------------------------ workers
    def start_worker(self, target, *args):
        self._cancel = False
        self.worker = threading.Thread(target=target, args=args, daemon=True)
        self.worker.start()
        self.after(100, self.poll_queue)

    def cancel(self):
        self._cancel = True

    def cancelled(self):
        return self._cancel

    def poll_queue(self):
        try:
            while True:
                msg = self.queue.get_nowait()
                if msg[0] == "log":
                    self._append_log(msg[1])
                else:
                    self.handle(msg)
        except queue.Empty:
            pass
        if self.worker and self.worker.is_alive():
            self.after(100, self.poll_queue)
        else:
            # vaciar lo que quede tras terminar el hilo
            try:
                while True:
                    msg = self.queue.get_nowait()
                    if msg[0] == "log":
                        self._append_log(msg[1])
                    else:
                        self.handle(msg)
            except queue.Empty:
                pass

    def handle(self, msg):
        """Cada fase implementa el manejo de sus mensajes."""
        raise NotImplementedError

    # -------------------------------------------------------------- varios
    @staticmethod
    def open_folder(path):
        import subprocess
        import sys as _sys
        try:
            if _sys.platform == "darwin":
                subprocess.Popen(["open", str(path)])
            elif _sys.platform.startswith("win"):
                import os
                os.startfile(str(path))  # type: ignore
            else:
                subprocess.Popen(["xdg-open", str(path)])
        except Exception:
            pass

    def collect_vars(self, prefix: str) -> dict:
        """Devuelve {nombre: valor} de todas las variables var_* de la fase,
        con un prefijo para no chocar entre fases al guardar la config."""
        out = {}
        for k, v in self.__dict__.items():
            if k.startswith("var_") and hasattr(v, "get"):
                try:
                    out[f"{prefix}{k}"] = v.get()
                except tk.TclError:
                    pass
        return out

    def restore_vars(self, prefix: str, data: dict):
        for key, val in data.items():
            if not key.startswith(prefix):
                continue
            name = key[len(prefix):]
            var = getattr(self, name, None)
            if var is not None and hasattr(var, "set"):
                try:
                    var.set(val)
                except (tk.TclError, ValueError):
                    pass
