"""Interfaz gráfica (Tkinter) de Kamiru — Video a Contact Sheets.

Pensada para usarse sin tocar código. Toda la lógica pesada (extracción y
composición) corre en un hilo aparte para que la ventana no se congele.
"""

from __future__ import annotations

import os

# Silencia el aviso inofensivo de "Tk is deprecated" en macOS. Debe fijarse
# antes de que se inicialice Tk (es decir, antes de importar tkinter).
os.environ.setdefault("TK_SILENCE_DEPRECATION", "1")

import queue
import shutil
import tempfile
import threading
import tkinter as tk
from pathlib import Path
from tkinter import colorchooser, filedialog, messagebox, ttk

from PIL import Image

from . import __app_name__, __version__, config, core, fonts as fontmod
from . import paper
from .ffmpeg_utils import VideoInfo, extract_frames, find_ffmpeg, probe

PAD = 10
VIDEO_TYPES = [
    ("Videos", "*.mp4 *.mov *.mkv *.avi *.webm *.m4v *.mpg *.mpeg *.wmv *.flv *.mts *.m2ts"),
    ("Todos los archivos", "*.*"),
]

# Tope de fotogramas a extraer para la vista previa de TODAS las hojas (evita
# que un video larguísimo congele la app; la generación final no tiene tope).
PREVIEW_ALL_CAP = 2000

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
}


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{__app_name__}  v{__version__}")
        self.minsize(900, 780)

        self.queue: "queue.Queue" = queue.Queue()
        self.worker = None
        self._cancel = False
        self._tmpdir = None
        self.video_info = VideoInfo()
        self.fonts_map = {}

        self._build_style()
        self._build_vars()
        self._build_ui()
        self._load_fonts_async()
        self._restore_config()
        self._update_estimate()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._bring_to_front()

    def _bring_to_front(self):
        # Al abrir desde el .app (sin terminal) la ventana puede quedar detrás
        # de otras; la traemos al frente un instante.
        try:
            self.lift()
            self.attributes("-topmost", True)
            self.after(400, lambda: self.attributes("-topmost", False))
        except tk.TclError:
            pass

    # ------------------------------------------------------------------ UI
    def _build_style(self):
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

        self.configure(bg=p["bg"])
        style = ttk.Style(self)
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

        # Pestañas
        style.configure("TNotebook", background=p["bg"], bordercolor=p["border"],
                        tabmargins=(4, 4, 4, 0))
        style.configure("TNotebook.Tab", padding=(15, 9),
                        background=p["tab_off"], foreground=p["muted"])
        style.map("TNotebook.Tab",
                  background=[("selected", p["card"])],
                  foreground=[("selected", p["accent_dark"])],
                  expand=[("selected", (1, 1, 1, 0))])

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

    def _build_vars(self):
        v = self
        # Video / rango
        v.var_video = tk.StringVar()
        v.var_range_mode = tk.StringVar(value="all")  # all | range
        v.var_start = tk.DoubleVar(value=0.0)
        v.var_end = tk.DoubleVar(value=0.0)
        # Extracción / cuadrícula
        v.var_extract_mode = tk.StringVar(value="fps")  # fps | all
        v.var_fps = tk.DoubleVar(value=2.0)
        v.var_cols = tk.IntVar(value=4)
        v.var_rows = tk.IntVar(value=5)
        # Selección de fotogramas (incluir / excluir por posición, p. ej. "1, 3-5")
        v.var_include = tk.StringVar(value="")
        v.var_exclude = tk.StringVar(value="")
        # Hoja
        v.var_paper = tk.StringVar(value="A4")
        v.var_orientation = tk.StringVar(value=core.ORIENTATIONS[0])
        v.var_dpi = tk.IntVar(value=300)
        v.var_custom_w = tk.DoubleVar(value=210.0)
        v.var_custom_h = tk.DoubleVar(value=297.0)
        v.var_margin = tk.DoubleVar(value=10.0)
        v.var_gutter = tk.DoubleVar(value=5.0)
        v.var_bg = tk.StringVar(value="#FFFFFF")
        # Etiquetas
        v.var_labels_on = tk.BooleanVar(value=True)
        v.var_base = tk.StringVar(value="abc")
        v.var_sep = tk.StringVar(value="_")
        v.var_zeros = tk.IntVar(value=1)
        v.var_startidx = tk.IntVar(value=1)
        v.var_numbering = tk.StringVar(value=core.NUMBERING[0])
        v.var_font_name = tk.StringVar()
        v.var_font_size = tk.DoubleVar(value=9.0)
        v.var_label_gap = tk.DoubleVar(value=1.5)
        v.var_label_color = tk.StringVar(value="#000000")
        # Nombre automático a partir del nombre del video.
        v.var_autoname = tk.BooleanVar(value=True)
        # Numeración de hoja
        v.var_pagenum_on = tk.BooleanVar(value=True)
        v.var_pagenum_corner = tk.StringVar(value=core.CORNERS[0])
        v.var_pagenum_prefix = tk.StringVar(value="")
        v.var_pagenum_start = tk.IntVar(value=1)
        v.var_pagenum_zeros = tk.IntVar(value=1)
        v.var_pagenum_size = tk.DoubleVar(value=11.0)
        v.var_pagenum_color = tk.StringVar(value="#000000")
        # Salida
        v.var_out_dir = tk.StringVar()
        v.var_out_name = tk.StringVar(value="contact_sheet")
        v.var_png = tk.BooleanVar(value=True)
        v.var_pdf = tk.BooleanVar(value=True)
        v.var_tiff = tk.BooleanVar(value=False)
        v.var_export_frames = tk.BooleanVar(value=False)

        # Recalcular estimación cuando cambien los valores clave.
        for var in (v.var_fps, v.var_cols, v.var_rows, v.var_start, v.var_end,
                    v.var_range_mode, v.var_extract_mode, v.var_include,
                    v.var_exclude):
            var.trace_add("write", lambda *_: self._update_estimate())

    def _build_ui(self):
        # Cabecera
        head = ttk.Frame(self, padding=(PAD * 2, PAD, PAD * 2, 0))
        head.pack(fill="x")
        ttk.Label(head, text="Video → Contact Sheets", style="Header.TLabel").pack(anchor="w")
        ttk.Label(head, text="Hecho con cariño para Kamila 💚  ·  sin pérdida de calidad, sin cambios de color",
                  style="Sub.TLabel").pack(anchor="w")

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=PAD * 2, pady=PAD)
        self._tab_video(nb)
        self._tab_grid(nb)
        self._tab_sheet(nb)
        self._tab_labels(nb)
        self._tab_pagenum(nb)
        self._tab_output(nb)

        # Barra inferior de acción
        bar = ttk.Frame(self, padding=(PAD * 2, 0, PAD * 2, PAD))
        bar.pack(fill="x")
        self.estimate_lbl = ttk.Label(bar, text="", style="Info.TLabel")
        self.estimate_lbl.pack(anchor="w", pady=(0, 4))
        self.progress = ttk.Progressbar(bar, mode="determinate")
        self.progress.pack(fill="x")
        self.status_lbl = ttk.Label(bar, text="Listo.", style="Sub.TLabel")
        self.status_lbl.pack(anchor="w", pady=(2, 6))

        btns = ttk.Frame(bar)
        btns.pack(fill="x")
        self.run_btn = ttk.Button(btns, text="Generar contact sheets",
                                  style="Accent.TButton", command=self._on_run)
        self.run_btn.pack(side="right")
        self.cancel_btn = ttk.Button(btns, text="Cancelar", command=self._on_cancel,
                                     state="disabled")
        self.cancel_btn.pack(side="right", padx=(0, PAD))
        self.preview_btn = ttk.Button(btns, text="👁  Vista previa",
                                      command=self._on_preview)
        self.preview_btn.pack(side="right", padx=(0, PAD))
        ttk.Button(btns, text="Ayuda", command=self._show_help).pack(side="left")

    def _section(self, parent, title):
        lf = ttk.LabelFrame(parent, text=title, padding=PAD)
        lf.pack(fill="x", padx=PAD, pady=(PAD, 0))
        lf.columnconfigure(1, weight=1)
        return lf

    def _tab_video(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="1 · Video")

        sec = self._section(tab, "Archivo de video")
        ttk.Entry(sec, textvariable=self.var_video).grid(row=0, column=0, columnspan=2,
                                                         sticky="ew", padx=(0, PAD))
        ttk.Button(sec, text="Examinar…", command=self._pick_video).grid(row=0, column=2)
        self.video_info_lbl = ttk.Label(sec, text="Aún no se ha cargado ningún video.",
                                        style="Sub.TLabel")
        self.video_info_lbl.grid(row=1, column=0, columnspan=3, sticky="w", pady=(6, 0))

        sec = self._section(tab, "Rango a procesar")
        ttk.Radiobutton(sec, text="Todo el video", variable=self.var_range_mode,
                        value="all", command=self._sync_range).grid(row=0, column=0,
                                                                    columnspan=3, sticky="w")
        ttk.Radiobutton(sec, text="Elegir inicio y fin (en segundos)",
                        variable=self.var_range_mode, value="range",
                        command=self._sync_range).grid(row=1, column=0, columnspan=3, sticky="w")
        self.range_box = ttk.Frame(sec)
        self.range_box.grid(row=2, column=0, columnspan=3, sticky="ew", pady=(4, 0))
        ttk.Label(self.range_box, text="Inicio (s):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(self.range_box, from_=0, to=999999, increment=0.5, width=10,
                    textvariable=self.var_start).grid(row=0, column=1, padx=(4, PAD * 2))
        ttk.Label(self.range_box, text="Fin (s):").grid(row=0, column=2, sticky="w")
        ttk.Spinbox(self.range_box, from_=0, to=999999, increment=0.5, width=10,
                    textvariable=self.var_end).grid(row=0, column=3, padx=4)
        self._sync_range()

    def _tab_grid(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="2 · Fotogramas")

        sec = self._section(tab, "¿Cuántos fotogramas extraer del video?")
        ttk.Radiobutton(sec, text="Muestrear N fotogramas por segundo (recomendado)",
                        variable=self.var_extract_mode, value="fps",
                        command=self._sync_extract).grid(row=0, column=0, columnspan=3, sticky="w")
        self.fps_box = ttk.Frame(sec)
        self.fps_box.grid(row=1, column=0, columnspan=3, sticky="w", padx=(20, 0))
        ttk.Label(self.fps_box, text="Fotogramas por segundo (fps):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(self.fps_box, from_=0.01, to=120, increment=0.5, width=8,
                    textvariable=self.var_fps).grid(row=0, column=1, padx=4)
        ttk.Label(self.fps_box, text="(admite decimales, p. ej. 0.5 = 1 cada 2 s)",
                  style="Sub.TLabel").grid(row=0, column=2, sticky="w", padx=(6, 0))
        ttk.Radiobutton(sec, text="Extraer TODOS los fotogramas del video (mixed media)",
                        variable=self.var_extract_mode, value="all",
                        command=self._sync_extract).grid(row=2, column=0, columnspan=3,
                                                         sticky="w", pady=(6, 0))
        self._sync_extract()

        sec = self._section(tab, "Imágenes por hoja (cuadrícula)")
        # Columnas y filas van juntas en un sub-marco para que NO se separen
        # cuando la ventana se maximiza (la columna 1 de la sección se estira).
        grid_box = ttk.Frame(sec)
        grid_box.grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(grid_box, text="Columnas:").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(grid_box, from_=1, to=50, width=6, textvariable=self.var_cols).grid(
            row=0, column=1, sticky="w", padx=(4, PAD * 2))
        ttk.Label(grid_box, text="Filas:").grid(row=0, column=2, sticky="w")
        ttk.Spinbox(grid_box, from_=1, to=50, width=6, textvariable=self.var_rows).grid(
            row=0, column=3, sticky="w", padx=4)
        self.perpage_lbl = ttk.Label(sec, text="", style="Sub.TLabel")
        self.perpage_lbl.grid(row=1, column=0, columnspan=2, sticky="w", pady=(6, 0))

        sec = self._section(tab, "Elegir qué fotogramas salen (opcional)")
        gb = ttk.Frame(sec)
        gb.grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(gb, text="Incluir solo:").grid(row=0, column=0, sticky="w")
        ttk.Entry(gb, textvariable=self.var_include, width=22).grid(
            row=0, column=1, sticky="w", padx=4)
        ttk.Label(gb, text="Excluir:").grid(row=0, column=2, sticky="w", padx=(PAD, 0))
        ttk.Entry(gb, textvariable=self.var_exclude, width=22).grid(
            row=0, column=3, sticky="w", padx=4)
        ttk.Label(sec, text='Por posición, p. ej. "1, 3-5" (vacío = todos). '
                            'Excluir tiene prioridad.',
                  style="Sub.TLabel").grid(row=1, column=0, columnspan=2,
                                           sticky="w", pady=(6, 0))

        sec = self._section(tab, "Espaciado entre frames")
        ttk.Label(sec, text="Separación entre imágenes (mm):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(sec, from_=0, to=100, increment=0.5, width=8,
                    textvariable=self.var_gutter).grid(row=0, column=1, sticky="w", padx=4)

    def _tab_sheet(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="3 · Hoja")

        sec = self._section(tab, "Tamaño y orientación")
        ttk.Label(sec, text="Tamaño de hoja:").grid(row=0, column=0, sticky="w")
        cb = ttk.Combobox(sec, values=paper.PAPER_ORDER, textvariable=self.var_paper,
                          state="readonly", width=22)
        cb.grid(row=0, column=1, sticky="w", padx=4)
        cb.bind("<<ComboboxSelected>>", lambda e: self._sync_custom())

        ttk.Label(sec, text="Orientación de la hoja:").grid(
            row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Combobox(sec, values=core.ORIENTATIONS, textvariable=self.var_orientation,
                     state="readonly", width=22).grid(
            row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Mejor ajuste = la orientación que agranda los fotogramas",
                  style="Sub.TLabel").grid(row=1, column=2, sticky="w", padx=PAD, pady=(6, 0))

        self.custom_box = ttk.Frame(sec)
        self.custom_box.grid(row=2, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(self.custom_box, text="Ancho (mm):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(self.custom_box, from_=10, to=2000, width=8,
                    textvariable=self.var_custom_w).grid(row=0, column=1, padx=4)
        ttk.Label(self.custom_box, text="Alto (mm):").grid(row=0, column=2, sticky="w")
        ttk.Spinbox(self.custom_box, from_=10, to=2000, width=8,
                    textvariable=self.var_custom_h).grid(row=0, column=3, padx=4)
        self._sync_custom()

        sec = self._section(tab, "Calidad y márgenes")
        ttk.Label(sec, text="Resolución (DPI):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(sec, from_=72, to=1200, increment=10, width=8,
                    textvariable=self.var_dpi).grid(row=0, column=1, sticky="w", padx=4)
        ttk.Label(sec, text="(300 = calidad de impresión)", style="Sub.TLabel").grid(
            row=0, column=2, sticky="w")
        ttk.Label(sec, text="Margen de la hoja (mm):").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=0, to=100, increment=0.5, width=8,
                    textvariable=self.var_margin).grid(row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Color de fondo:").grid(row=2, column=0, sticky="w", pady=(6, 0))
        self._color_picker(sec, self.var_bg, row=2, col=1)

    def _tab_labels(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="4 · Nombres")

        sec = self._section(tab, "Etiquetas autoincrementales")
        ttk.Checkbutton(sec, text="Escribir el nombre debajo de cada frame",
                        variable=self.var_labels_on,
                        command=self._update_name_preview).grid(row=0, column=0, columnspan=4, sticky="w")
        ttk.Label(sec, text="Nombre base:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        e = ttk.Entry(sec, textvariable=self.var_base, width=18)
        e.grid(row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Separador:").grid(row=1, column=2, sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_sep, width=6).grid(row=1, column=3, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Dígitos (ceros a la izq.):").grid(row=2, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=1, to=8, width=6, textvariable=self.var_zeros,
                    command=self._update_name_preview).grid(row=2, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Empezar en:").grid(row=2, column=2, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=0, to=999999, width=8, textvariable=self.var_startidx,
                    command=self._update_name_preview).grid(row=2, column=3, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Numeración:").grid(row=3, column=0, sticky="w", pady=(6, 0))
        ttk.Combobox(sec, values=core.NUMBERING, textvariable=self.var_numbering,
                     state="readonly", width=28).grid(
            row=3, column=1, columnspan=3, sticky="w", padx=4, pady=(6, 0))
        for var in (self.var_base, self.var_sep, self.var_zeros, self.var_startidx,
                    self.var_numbering):
            var.trace_add("write", lambda *_: self._update_name_preview())
        self.name_preview = ttk.Label(sec, text="", style="Info.TLabel")
        self.name_preview.grid(row=4, column=0, columnspan=4, sticky="w", pady=(8, 0))
        ttk.Checkbutton(
            sec, text="Usar el nombre del video automáticamente (nombre base y archivos)",
            variable=self.var_autoname, command=self._apply_autoname).grid(
            row=5, column=0, columnspan=4, sticky="w", pady=(8, 0))

        sec = self._section(tab, "Tipografía de los nombres")
        ttk.Label(sec, text="Fuente:").grid(row=0, column=0, sticky="w")
        self.font_cb = ttk.Combobox(sec, textvariable=self.var_font_name,
                                    state="readonly", width=30, values=["(cargando fuentes…)"])
        self.font_cb.grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(sec, text="Archivo…", command=self._pick_font).grid(row=0, column=2)
        ttk.Label(sec, text="Tamaño de fuente (pt):").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=4, to=72, increment=0.5, width=8,
                    textvariable=self.var_font_size).grid(row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Margen frame↔texto (mm):").grid(row=2, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=0, to=30, increment=0.5, width=8,
                    textvariable=self.var_label_gap).grid(row=2, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Color del texto:").grid(row=3, column=0, sticky="w", pady=(6, 0))
        self._color_picker(sec, self.var_label_color, row=3, col=1)

    def _tab_pagenum(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="5 · Nº de hoja")

        sec = self._section(tab, "Número de hoja en la esquina")
        ttk.Checkbutton(sec, text="Mostrar el número de hoja (para organizarte mejor)",
                        variable=self.var_pagenum_on).grid(row=0, column=0, columnspan=4, sticky="w")
        ttk.Label(sec, text="Posición:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Combobox(sec, values=core.CORNERS, textvariable=self.var_pagenum_corner,
                     state="readonly", width=20).grid(row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Texto antes del número:").grid(row=2, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_pagenum_prefix, width=16).grid(
            row=2, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text='(p. ej. "Hoja ")', style="Sub.TLabel").grid(
            row=2, column=2, sticky="w", pady=(6, 0))
        ttk.Label(sec, text="Empezar en:").grid(row=3, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=0, to=999999, width=8,
                    textvariable=self.var_pagenum_start).grid(row=3, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Dígitos (ceros a la izq.):").grid(
            row=3, column=2, sticky="w", padx=(PAD, 0), pady=(6, 0))
        ttk.Spinbox(sec, from_=1, to=8, width=6,
                    textvariable=self.var_pagenum_zeros).grid(
            row=3, column=3, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Tamaño de fuente (pt):").grid(row=4, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=4, to=72, increment=0.5, width=8,
                    textvariable=self.var_pagenum_size).grid(row=4, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Color:").grid(row=5, column=0, sticky="w", pady=(6, 0))
        self._color_picker(sec, self.var_pagenum_color, row=5, col=1)

    def _tab_output(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="6 · Salida")

        sec = self._section(tab, "Dónde guardar")
        ttk.Label(sec, text="Carpeta de salida:").grid(row=0, column=0, sticky="w")
        ttk.Entry(sec, textvariable=self.var_out_dir).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(sec, text="Examinar…", command=self._pick_outdir).grid(row=0, column=2)
        ttk.Label(sec, text="Nombre de los archivos:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_out_name, width=28).grid(
            row=1, column=1, sticky="w", padx=4, pady=(6, 0))

        sec = self._section(tab, "Formatos a generar")
        ttk.Checkbutton(sec, text="PNG por hoja (sin pérdida, recomendado)",
                        variable=self.var_png).grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(sec, text="PDF combinado (ideal para imprimir)",
                        variable=self.var_pdf).grid(row=1, column=0, sticky="w")
        ttk.Checkbutton(sec, text="TIFF por hoja (sin pérdida, archivo grande)",
                        variable=self.var_tiff).grid(row=2, column=0, sticky="w")
        ttk.Checkbutton(sec, text="Además, guardar cada fotograma individual a máxima calidad (PNG con su nombre)",
                        variable=self.var_export_frames).grid(row=3, column=0, sticky="w", pady=(6, 0))

    # ----------------------------------------------------------- widgets aux
    def _color_picker(self, parent, var, row, col):
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
        ttk.Button(box, text="Cambiar", command=choose, width=8).pack(side="left", padx=(4, 0))

    @staticmethod
    def _safe_bg(widget, var):
        try:
            widget.configure(bg=var.get())
        except tk.TclError:
            pass

    # ----------------------------------------------------------- fuentes
    def _load_fonts_async(self):
        def work():
            fmap = fontmod.discover_fonts()
            self.queue.put(("fonts", fmap))
        threading.Thread(target=work, daemon=True).start()
        self.after(100, self._poll_queue)

    def _apply_fonts(self, fmap):
        self.fonts_map = fmap
        names = list(fmap.keys())
        if names:
            self.font_cb.configure(values=names)
            if not self.var_font_name.get() or self.var_font_name.get() not in fmap:
                name, _ = fontmod.default_font(fmap)
                if name:
                    self.var_font_name.set(name)
        else:
            self.font_cb.configure(values=["(se usará la fuente por defecto)"])

    def _pick_font(self):
        path = filedialog.askopenfilename(
            title="Elegir archivo de fuente",
            filetypes=[("Fuentes", "*.ttf *.otf *.ttc"), ("Todos", "*.*")],
        )
        if path:
            name = f"📁 {Path(path).name}"
            self.fonts_map[name] = path
            self.font_cb.configure(values=list(self.fonts_map.keys()))
            self.var_font_name.set(name)

    def _font_path(self):
        return self.fonts_map.get(self.var_font_name.get())

    # ----------------------------------------------------------- acciones
    def _pick_video(self):
        path = filedialog.askopenfilename(title="Elegir video", filetypes=VIDEO_TYPES)
        if not path:
            return
        self.var_video.set(path)
        stem = Path(path).stem
        if self.var_autoname.get():
            # Nombre base y nombre de archivo = nombre del video (+ sufijos).
            self.var_out_name.set(stem)
            self.var_base.set(stem)
        elif not self.var_out_name.get() or self.var_out_name.get() == "contact_sheet":
            self.var_out_name.set(stem)
        if not self.var_out_dir.get():
            self.var_out_dir.set(str(Path(path).parent / "contact_sheets"))
        self._probe_async(path)
        self._update_name_preview()

    def _apply_autoname(self):
        """Si el nombre automático está activo y hay video, rellena los nombres."""
        if self.var_autoname.get() and self.var_video.get():
            stem = Path(self.var_video.get()).stem
            self.var_out_name.set(stem)
            self.var_base.set(stem)
            self._update_name_preview()

    def _probe_async(self, path):
        self.video_info_lbl.configure(text="Leyendo el video…")

        def work():
            try:
                ff = find_ffmpeg()
                info = probe(ff, path)
                self.queue.put(("probe", info))
            except Exception as e:
                self.queue.put(("probe_err", str(e)))
        threading.Thread(target=work, daemon=True).start()
        self.after(100, self._poll_queue)

    def _apply_probe(self, info: VideoInfo):
        self.video_info = info
        res = f"{info.width}×{info.height}" if info.width else "resolución desconocida"
        fps = f"{info.fps:g} fps" if info.fps else "fps desconocido"
        self.video_info_lbl.configure(
            text=f"Duración: {info.duration_hhmmss}  ·  {res}  ·  {fps}")
        if info.duration and (not self.var_end.get() or self.var_end.get() == 0):
            self.var_end.set(round(info.duration, 2))
        self._update_estimate()

    def _pick_outdir(self):
        d = filedialog.askdirectory(title="Elegir carpeta de salida")
        if d:
            self.var_out_dir.set(d)

    def _sync_range(self):
        state = "normal" if self.var_range_mode.get() == "range" else "disabled"
        for child in self.range_box.winfo_children():
            try:
                child.configure(state=state)
            except tk.TclError:
                pass
        self._update_estimate()

    def _sync_extract(self):
        state = "normal" if self.var_extract_mode.get() == "fps" else "disabled"
        for child in self.fps_box.winfo_children():
            try:
                child.configure(state=state)
            except tk.TclError:
                pass
        self._update_estimate()

    def _sync_custom(self):
        state = "normal" if self.var_paper.get() == "Personalizado" else "disabled"
        for child in self.custom_box.winfo_children():
            try:
                child.configure(state=state)
            except tk.TclError:
                pass

    def _update_name_preview(self):
        if not self.var_labels_on.get():
            self.name_preview.configure(text="(nombres desactivados)")
            return
        try:
            s = self._settings_for_preview()
            if self.var_numbering.get().lower().startswith("original"):
                ex = ", ".join(s.format_label(n) for n in (5, 10, 15))
                self.name_preview.configure(
                    text=f"Ejemplo (posición real en el video):  {ex}, …")
            else:
                ex = ", ".join(s.label_for(i) for i in range(3))
                self.name_preview.configure(text=f"Ejemplo:  {ex}, …")
        except Exception:
            self.name_preview.configure(text="")

    def _settings_for_preview(self):
        return core.Settings(
            base_name=self.var_base.get(), separator=self.var_sep.get(),
            leading_zeros=self._int(self.var_zeros, 1),
            start_index=self._int(self.var_startidx, 1),
        )

    # ----------------------------------------------------------- estimación
    def _selected_range(self):
        if self.var_range_mode.get() == "range":
            start = max(0.0, self._float(self.var_start, 0.0))
            end = self._float(self.var_end, 0.0)
            if end <= start and self.video_info.duration:
                end = self.video_info.duration
            return start, (end if end > start else None)
        # Todo el video
        return 0.0, (self.video_info.duration or None)

    def _update_estimate(self, *_):
        # Puede invocarse mientras se construyen las pestañas (p. ej. desde
        # _sync_range), antes de que existan las etiquetas de la barra inferior.
        # En ese caso no hay nada que actualizar todavía.
        if not hasattr(self, "estimate_lbl"):
            return
        per_page = max(1, self._int(self.var_cols, 1) * self._int(self.var_rows, 1))
        if hasattr(self, "perpage_lbl"):
            self.perpage_lbl.configure(text=f"= {per_page} imágenes por hoja")
        start, end = self._selected_range()
        frames = None
        if self.var_extract_mode.get() == "fps":
            fps = self._float(self.var_fps, 0)
            if end is not None and fps > 0:
                frames = max(1, int(round((end - start) * fps)))
        else:  # todos los fotogramas
            if end is not None and self.video_info.fps:
                frames = max(1, int(round((end - start) * self.video_info.fps)))
        if frames:
            sel_txt = ""
            inc = core.parse_ranges(self.var_include.get(), frames)
            exc = core.parse_ranges(self.var_exclude.get(), frames)
            if inc or exc:
                kept = sum(1 for i in range(1, frames + 1)
                           if (not inc or i in inc) and i not in exc)
                sel_txt = f" (de {frames} extraídos)"
                frames = max(0, kept)
            pages = core.estimate_pages(frames, per_page)
            self.estimate_lbl.configure(
                text=f"≈ {frames} fotogramas{sel_txt}  →  {pages} hoja(s)  "
                     f"({per_page} por hoja)")
        else:
            self.estimate_lbl.configure(
                text=f"{per_page} imágenes por hoja  ·  carga un video para estimar el total")

    # ----------------------------------------------------------- ejecutar
    def _collect_settings(self) -> core.Settings:
        return core.Settings(
            paper=self.var_paper.get(), orientation=self.var_orientation.get(),
            dpi=self._int(self.var_dpi, 300),
            custom_w_mm=self._float(self.var_custom_w, 210),
            custom_h_mm=self._float(self.var_custom_h, 297),
            margin_mm=self._float(self.var_margin, 10),
            gutter_mm=self._float(self.var_gutter, 5),
            bg_color=self.var_bg.get(),
            cols=self._int(self.var_cols, 4), rows=self._int(self.var_rows, 5),
            labels_on=self.var_labels_on.get(), base_name=self.var_base.get(),
            separator=self.var_sep.get(), leading_zeros=self._int(self.var_zeros, 1),
            start_index=self._int(self.var_startidx, 1), font_path=self._font_path(),
            font_size_pt=self._float(self.var_font_size, 9),
            label_gap_mm=self._float(self.var_label_gap, 1.5),
            label_color=self.var_label_color.get(),
            page_num_on=self.var_pagenum_on.get(),
            page_num_corner=self.var_pagenum_corner.get(),
            page_num_prefix=self.var_pagenum_prefix.get(),
            page_num_start=self._int(self.var_pagenum_start, 1),
            page_num_zeros=self._int(self.var_pagenum_zeros, 1),
            page_num_size_pt=self._float(self.var_pagenum_size, 11),
            page_num_color=self.var_pagenum_color.get(),
            out_dir=self.var_out_dir.get(), out_name=self.var_out_name.get() or "contact_sheet",
            fmt_png=self.var_png.get(), fmt_pdf=self.var_pdf.get(),
            fmt_tiff=self.var_tiff.get(), export_frames=self.var_export_frames.get(),
        )

    def _validate(self, s: core.Settings):
        if not self.var_video.get() or not Path(self.var_video.get()).exists():
            return "Elige primero un archivo de video válido."
        if not s.out_dir:
            return "Elige una carpeta de salida (pestaña 6 · Salida)."
        if not (s.fmt_png or s.fmt_pdf or s.fmt_tiff):
            return "Selecciona al menos un formato de salida (pestaña 6)."
        if self.var_extract_mode.get() == "fps" and self._float(self.var_fps, 0) <= 0:
            return "El valor de fps debe ser mayor que 0."
        return None

    def _on_run(self):
        s = self._collect_settings()
        err = self._validate(s)
        if err:
            messagebox.showwarning("Falta algo", err)
            return
        start, end = self._selected_range()
        fps = self._float(self.var_fps, 0) if self.var_extract_mode.get() == "fps" else None
        inc, exc = self.var_include.get(), self.var_exclude.get()
        orig = self.var_numbering.get().lower().startswith("original")

        self._cancel = False
        self._set_busy(True)
        self.progress.configure(value=0, maximum=100)
        self._set_status("Preparando…")

        self.worker = threading.Thread(
            target=self._work, args=(s, start, end, fps, inc, exc, orig), daemon=True)
        self.worker.start()
        self.after(100, self._poll_queue)

    def _work(self, settings, start, end, fps, inc, exc, numbering_original):
        tmp = None
        try:
            ff = find_ffmpeg()
            tmp = tempfile.mkdtemp(prefix="kamiru_")
            self._tmpdir = tmp
            self.queue.put(("status", "Extrayendo fotogramas del video…"))

            def ext_progress(done, total):
                self.queue.put(("extract", done, total))

            frames = extract_frames(
                ff, self.var_video.get(), tmp,
                start=start, end=end, fps=fps,
                progress_cb=ext_progress, cancel_check=lambda: self._cancel,
            )
            positions = core.select_indices(len(frames), inc, exc)
            if not positions:
                raise ValueError(
                    "La selección de «Incluir/Excluir» (pestaña 2) no deja "
                    "ningún fotograma. Revisa esos campos.")
            sel = [frames[i - 1] for i in positions]
            numbers = positions if numbering_original else None
            if len(sel) != len(frames):
                self.queue.put(("status",
                                f"{len(sel)} de {len(frames)} fotogramas seleccionados. "
                                "Componiendo hojas…"))
            else:
                self.queue.put(("status",
                                f"{len(sel)} fotogramas. Componiendo hojas…"))

            def comp_progress(done, total):
                self.queue.put(("compose", done, total))

            result = core.generate(
                settings, sel, numbers=numbers, progress_cb=comp_progress,
                cancel_check=lambda: self._cancel)
            self.queue.put(("done", result))
        except Exception as e:
            if self._cancel:
                self.queue.put(("cancelled", None))
            else:
                self.queue.put(("error", str(e)))
        finally:
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)

    # ----------------------------------------------------------- vista previa
    def _on_preview(self):
        if not self.var_video.get() or not Path(self.var_video.get()).exists():
            messagebox.showwarning("Falta algo", "Elige primero un archivo de video válido.")
            return
        if self.var_extract_mode.get() == "fps" and self._float(self.var_fps, 0) <= 0:
            messagebox.showwarning("Falta algo", "El valor de fps debe ser mayor que 0.")
            return
        s = self._collect_settings()
        start, end = self._selected_range()
        fps = self._float(self.var_fps, 0) if self.var_extract_mode.get() == "fps" else None
        inc, exc = self.var_include.get(), self.var_exclude.get()
        orig = self.var_numbering.get().lower().startswith("original")

        self._cancel = False
        self._set_busy(True)
        self.progress.configure(mode="indeterminate")
        self.progress.start(12)
        self._set_status("Preparando vista previa…")

        self.worker = threading.Thread(
            target=self._work_preview, args=(s, start, end, fps, inc, exc, orig),
            daemon=True)
        self.worker.start()
        self.after(100, self._poll_queue)

    def _work_preview(self, settings, start, end, fps, inc, exc, numbering_original):
        tmp = None
        keep_tmp = False
        try:
            ff = find_ffmpeg()
            tmp = tempfile.mkdtemp(prefix="kamiru_pv_")
            self.queue.put(("status", "Extrayendo fotogramas para la vista previa…"))

            def ext_progress(done, total):
                self.queue.put(("extract", done, total))

            # Extraemos todos los fotogramas del rango (hasta un tope alto) para
            # poder previsualizar TODAS las hojas, no solo la primera.
            frames = extract_frames(
                ff, self.var_video.get(), tmp,
                start=start, end=end, fps=fps, max_frames=PREVIEW_ALL_CAP,
                progress_cb=ext_progress, cancel_check=lambda: self._cancel,
            )
            positions = core.select_indices(len(frames), inc, exc)
            if not positions:
                raise ValueError(
                    "La selección de «Incluir/Excluir» no deja ningún fotograma "
                    "para previsualizar.")
            sel = [frames[i - 1] for i in positions]
            numbers = positions if numbering_original else None
            self.queue.put(("status", "Renderizando vista previa…"))
            first_img, num_pages = core.render_preview(settings, sel, 0, numbers=numbers)
            truncated = len(frames) >= PREVIEW_ALL_CAP
            # No borramos tmp: las demás hojas se renderizan bajo demanda al
            # navegar. La ventana de preview limpiará la carpeta al cerrarse.
            keep_tmp = True
            self.queue.put(("preview_multi",
                            (first_img, sel, settings, num_pages, len(sel), tmp,
                             truncated, numbers)))
        except Exception as e:
            if self._cancel:
                self.queue.put(("cancelled", None))
            else:
                self.queue.put(("error", str(e)))
        finally:
            if tmp and not keep_tmp:
                shutil.rmtree(tmp, ignore_errors=True)

    def _on_cancel(self):
        self._cancel = True
        self._set_status("Cancelando…")

    # ----------------------------------------------------------- cola/eventos
    def _poll_queue(self):
        try:
            while True:
                msg = self.queue.get_nowait()
                self._handle(msg)
        except queue.Empty:
            pass
        # Sigue sondeando mientras haya trabajo en curso.
        if (self.worker and self.worker.is_alive()):
            self.after(100, self._poll_queue)

    def _handle(self, msg):
        kind = msg[0]
        if kind == "fonts":
            self._apply_fonts(msg[1])
        elif kind == "probe":
            self._apply_probe(msg[1])
        elif kind == "probe_err":
            self.video_info_lbl.configure(text=f"No se pudo leer el video: {msg[1]}")
        elif kind == "status":
            self._set_status(msg[1])
        elif kind == "extract":
            done, total = msg[1], msg[2]
            if total:
                self.progress.configure(maximum=total, value=min(done, total))
                self._set_status(f"Extrayendo fotogramas…  {done}/{total}")
            else:
                self.progress.configure(mode="indeterminate")
                self.progress.start(12)
                self._set_status(f"Extrayendo fotogramas…  {done}")
        elif kind == "compose":
            done, total = msg[1], msg[2]
            self.progress.configure(mode="determinate")
            self.progress.stop()
            self.progress.configure(maximum=max(1, total), value=done)
            self._set_status(f"Componiendo hojas…  {done}/{total}")
        elif kind == "preview_multi":
            (first_img, frames, settings, num_pages, nsel, tmpdir,
             truncated, numbers) = msg[1]
            self._reset_run()
            self._set_status(f"Vista previa lista ({num_pages} hoja(s)).")
            self._show_multi_preview(first_img, frames, settings, num_pages,
                                     nsel, tmpdir, truncated, numbers)
        elif kind == "done":
            self._finish_ok(msg[1])
        elif kind == "cancelled":
            self._reset_run()
            self._set_status("Cancelado.")
        elif kind == "error":
            self._reset_run()
            self._set_status("Error.")
            messagebox.showerror("Ups, algo falló", msg[1])

    def _finish_ok(self, result):
        self.progress.stop()
        self.progress.configure(mode="determinate", value=self.progress["maximum"])
        self._reset_run()
        n = result.get("num_pages", 0)
        orient = result.get("orientation", "")
        self._set_status(f"¡Listo! Se generaron {n} hoja(s).")
        self._save_config()
        extra = ""
        if orient:
            suf = "  (elegida automáticamente)" if self.var_orientation.get().lower().startswith("mejor") else ""
            extra += f"\nOrientación: {orient}{suf}"
        if result.get("pdf"):
            extra += f"\nPDF: {result['pdf']}"
        if result.get("frames_dir"):
            extra += f"\nFotogramas individuales: {result['frames_dir']}"
        if messagebox.askyesno(
                "¡Contact sheets generados! 🎉",
                f"Se crearon {n} hoja(s) en:\n{self.var_out_dir.get()}{extra}\n\n"
                "¿Abrir la carpeta de salida?"):
            self._open_folder(self.var_out_dir.get())

    def _set_busy(self, busy):
        state = "disabled" if busy else "normal"
        self.run_btn.configure(state=state)
        self.preview_btn.configure(state=state)
        self.cancel_btn.configure(state="normal" if busy else "disabled")

    def _reset_run(self):
        self._set_busy(False)
        try:
            self.progress.stop()
            self.progress.configure(mode="determinate")
        except tk.TclError:
            pass
        self.worker = None

    def _show_multi_preview(self, first_img, frames, settings, num_pages, nsel,
                            tmpdir, truncated, numbers=None):
        """Ventana de vista previa con navegación por TODAS las hojas.

        La hoja 0 ya viene renderizada; las demás se renderizan bajo demanda al
        navegar (y se cachean). Los fotogramas temporales viven en tmpdir hasta
        que se cierra la ventana.
        """
        try:
            from PIL import ImageTk
        except Exception:
            p = Path(tempfile.mkdtemp(prefix="kamiru_pv_")) / "vista_previa.png"
            first_img.save(p)
            shutil.rmtree(tmpdir, ignore_errors=True)
            messagebox.showinfo("Vista previa", f"Se guardó la vista previa en:\n{p}")
            self._open_folder(str(p.parent))
            return

        win = tk.Toplevel(self)
        win.title("Vista previa de las hojas")
        win.configure(bg=PALETTE["bg"])
        win.transient(self)

        state = {"idx": 0, "cache": {0: first_img}, "photo": None}

        img_lbl = ttk.Label(win, anchor="center")
        img_lbl.pack(padx=12, pady=(12, 6))
        info_lbl = ttk.Label(win, text="", style="Sub.TLabel")
        info_lbl.pack(pady=(0, 8))

        nav = ttk.Frame(win)
        nav.pack(pady=(0, 12))
        page_var = tk.IntVar(value=1)

        def render_pil(k):
            if k not in state["cache"]:
                img, _ = core.render_preview(settings, frames, k, numbers=numbers)
                state["cache"][k] = img
            return state["cache"][k]

        def show(k):
            k = max(0, min(int(k), num_pages - 1))
            state["idx"] = k
            pil = render_pil(k)
            max_w, max_h = 980, 660
            w, h = pil.size
            scale = min(max_w / w, max_h / h, 1.0)
            disp = (pil.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                               Image.LANCZOS) if scale < 1 else pil)
            photo = ImageTk.PhotoImage(disp)
            state["photo"] = photo  # mantener referencia
            img_lbl.configure(image=photo)
            note = (f"{nsel} fotograma(s) en la selección  ·  vista a baja "
                    "resolución (las hojas finales serán nítidas)")
            if truncated:
                note += f"  ·  preview limitada a las primeras {PREVIEW_ALL_CAP} imágenes"
            info_lbl.configure(text=note)
            page_var.set(k + 1)
            prev_btn.configure(state="normal" if k > 0 else "disabled")
            next_btn.configure(state="normal" if k < num_pages - 1 else "disabled")

        prev_btn = ttk.Button(nav, text="◀ Anterior", command=lambda: show(state["idx"] - 1))
        prev_btn.grid(row=0, column=0, padx=4)
        ttk.Label(nav, text="Hoja").grid(row=0, column=1, padx=(8, 2))
        ttk.Spinbox(nav, from_=1, to=num_pages, width=5, textvariable=page_var,
                    command=lambda: show(page_var.get() - 1)).grid(row=0, column=2)
        ttk.Label(nav, text=f"de {num_pages}").grid(row=0, column=3, padx=(2, 8))
        next_btn = ttk.Button(nav, text="Siguiente ▶", command=lambda: show(state["idx"] + 1))
        next_btn.grid(row=0, column=4, padx=4)

        def on_close():
            shutil.rmtree(tmpdir, ignore_errors=True)
            win.destroy()

        ttk.Button(nav, text="Cerrar", command=on_close).grid(row=0, column=5, padx=(16, 4))
        win.bind("<Left>", lambda e: show(state["idx"] - 1))
        win.bind("<Right>", lambda e: show(state["idx"] + 1))
        win.bind("<Return>", lambda e: show(page_var.get() - 1))
        win.protocol("WM_DELETE_WINDOW", on_close)

        show(0)
        win.update_idletasks()
        win.minsize(win.winfo_reqwidth(), win.winfo_reqheight())
        win.focus_set()

    def _set_status(self, text):
        self.status_lbl.configure(text=text)

    @staticmethod
    def _open_folder(path):
        import subprocess
        import sys as _sys
        try:
            if _sys.platform == "darwin":
                subprocess.Popen(["open", path])
            elif _sys.platform.startswith("win"):
                import os
                os.startfile(path)  # type: ignore
            else:
                subprocess.Popen(["xdg-open", path])
        except Exception:
            pass

    # ----------------------------------------------------------- ayuda
    def _show_help(self):
        messagebox.showinfo(
            "Cómo usar Kamiru",
            "1) Pestaña 1: elige el video y el rango (todo o inicio/fin en segundos).\n"
            "2) Pestaña 2: cuántos fotogramas extraer (fps o todos), la cuadrícula "
            "(columnas × filas = imágenes por hoja) y, si quieres, qué fotogramas "
            "incluir o excluir (p. ej. «1, 3-5»).\n"
            "3) Pestaña 3: tamaño de hoja (A4 u otros), orientación "
            "(vertical, horizontal o mejor ajuste automático), DPI y márgenes.\n"
            "4) Pestaña 4: nombre base, separador y ceros para los nombres "
            "(abc_001, abc_002, …) y la fuente/tamaño.\n"
            "5) Pestaña 5: numerador de hoja en la esquina.\n"
            "6) Pestaña 6: carpeta, nombre de archivo y formatos (PNG/PDF/TIFF).\n\n"
            "Usa «👁 Vista previa» para ver la primera hoja antes de generar todo.\n"
            "Pulsa «Generar contact sheets». Las imágenes se extraen en PNG sin "
            "pérdida y sin alterar el color.")

    # ----------------------------------------------------------- config
    def _config_dict(self) -> dict:
        return {k: getattr(self, k).get() for k in self.__dict__
                if k.startswith("var_")}

    def _save_config(self):
        data = self._config_dict()
        data["font_name"] = self.var_font_name.get()
        config.save(data)

    def _restore_config(self):
        data = config.load()
        if not data:
            return
        for key, val in data.items():
            var = getattr(self, key, None)
            if var is not None and hasattr(var, "set"):
                try:
                    var.set(val)
                except (tk.TclError, ValueError):
                    pass
        self._sync_range()
        self._sync_extract()
        self._sync_custom()
        self._update_name_preview()

    def _on_close(self):
        try:
            self._save_config()
        finally:
            self.destroy()

    # ----------------------------------------------------------- utilidades
    @staticmethod
    def _int(var, default):
        try:
            return int(float(var.get()))
        except (tk.TclError, ValueError):
            return default

    @staticmethod
    def _float(var, default):
        try:
            return float(var.get())
        except (tk.TclError, ValueError):
            return default


def main():
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
