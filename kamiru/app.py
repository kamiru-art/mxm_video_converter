"""Interfaz gráfica (Tkinter) de Kamiru Studio.

Pensada para usarse sin tocar código. La app tiene 4 fases (pestañas grandes):

    ① Generar hojas      video/carpeta → contact sheets (con o sin marcadores)
    ② Procesar escaneos  escaneos pintados/expuestos → fotogramas digitales
    ③ Calibración        perfiles de impresora y de cianotipia
    ④ Video final        fotogramas procesados → video

Toda la lógica pesada corre en hilos aparte para que la ventana no se congele.
"""

from __future__ import annotations

import os

# Silencia el aviso inofensivo de "Tk is deprecated" en macOS. Debe fijarse
# antes de que se inicialice Tk (es decir, antes de importar tkinter).
os.environ.setdefault("TK_SILENCE_DEPRECATION", "1")

import shutil
import tempfile
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from PIL import Image

from . import __app_name__, __version__, config, core, dedup
from . import fonts as fontmod
from . import markers, paper
from .ffmpeg_utils import VideoInfo, extract_frames, find_ffmpeg, probe
from .gui_common import PAD, PALETTE, PhaseFrame, build_style, show_guide
from .gui_phases import NO_COLOR_PROFILE, CalibPhase, ScansPhase, VideoPhase

VIDEO_TYPES = [
    ("Videos", "*.mp4 *.mov *.mkv *.avi *.webm *.m4v *.mpg *.mpeg *.wmv *.flv *.mts *.m2ts"),
    ("Todos los archivos", "*.*"),
]

IMG_EXTS = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp", ".webp"}

# Tope de fotogramas a extraer para la vista previa de TODAS las hojas (evita
# que un video larguísimo congele la app; la generación final no tiene tope).
PREVIEW_ALL_CAP = 2000

NO_PRINTER = "(sin perfil)"
NO_CURVE = "(sin curva — lineal)"

LABEL_SOURCES = [
    "Nombre base + número (abc_001)",
    "Nombre del archivo de imagen",
]


class SheetsPhase(PhaseFrame):
    """Fase ②: de un video (o carpeta de imágenes) a hojas imprimibles."""

    def __init__(self, master, app):
        super().__init__(master, app)
        self._tmpdir = None
        self.video_info = VideoInfo()
        self.fonts_map = {}
        self._folder_count = 0

        self._build_vars()
        self._build_ui()
        self._load_fonts_async()
        self.refresh_profiles()
        self._update_estimate()
        self._poll_forever()

    # ------------------------------------------------------------------ vars
    def _build_vars(self):
        v = self
        # Origen
        v.var_source = tk.StringVar(value="video")  # video | folder
        v.var_video = tk.StringVar()
        v.var_frames_dir = tk.StringVar()
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
        # Deduplicación
        v.var_dedup = tk.BooleanVar(value=False)
        v.var_dedup_thr = tk.IntVar(value=4)
        # Hoja
        v.var_paper = tk.StringVar(value="A4")
        v.var_orientation = tk.StringVar(value=core.ORIENTATIONS[0])
        v.var_dpi = tk.IntVar(value=300)
        v.var_custom_w = tk.DoubleVar(value=210.0)
        v.var_custom_h = tk.DoubleVar(value=297.0)
        v.var_margin = tk.DoubleVar(value=10.0)
        v.var_gutter = tk.DoubleVar(value=5.0)
        v.var_bg = tk.StringVar(value="#FFFFFF")
        v.var_printer_profile = tk.StringVar(value=NO_PRINTER)
        # Etiquetas
        v.var_labels_on = tk.BooleanVar(value=True)
        v.var_label_source = tk.StringVar(value=LABEL_SOURCES[0])
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
        v.var_pagenum_order = tk.StringVar(value=core.PAGE_NUMBERING[0])
        v.var_pagenum_size = tk.DoubleVar(value=11.0)
        v.var_pagenum_color = tk.StringVar(value="#000000")
        # Marcadores de registro
        v.var_reg_on = tk.BooleanVar(value=True)
        v.var_marker_count = tk.IntVar(value=8)
        v.var_marker_size = tk.DoubleVar(value=8.0)
        v.var_marker_margin = tk.DoubleVar(value=4.0)
        v.var_qr_on = tk.BooleanVar(value=True)
        v.var_qr_size = tk.DoubleVar(value=10.0)
        v.var_patch_on = tk.BooleanVar(value=False)
        v.var_project = tk.StringVar(value="")
        # Cianotipia
        v.var_cyan_on = tk.BooleanVar(value=False)
        v.var_cyan_mirror = tk.BooleanVar(value=True)
        v.var_cyan_ink = tk.StringVar(value="#000000")
        v.var_cyan_curve = tk.StringVar(value=NO_CURVE)
        v.var_cyan_sim = tk.BooleanVar(value=False)
        v.var_cyan_bg = tk.StringVar(value="ahorro")  # ahorro | completo
        v.var_cyan_halo = tk.DoubleVar(value=5.0)
        v.var_cyan_border = tk.DoubleVar(value=0.8)
        v.var_cyan_block_on = tk.BooleanVar(value=False)
        v.var_cyan_block_color = tk.StringVar(value="#000000")
        v.var_cyan_colorprofile = tk.StringVar(value=NO_COLOR_PROFILE)
        # Salida
        v.var_out_dir = tk.StringVar()
        v.var_out_name = tk.StringVar(value="contact_sheet")
        v.var_png = tk.BooleanVar(value=True)
        v.var_pdf = tk.BooleanVar(value=True)
        v.var_tiff = tk.BooleanVar(value=False)
        v.var_export_frames = tk.BooleanVar(value=False)
        v.var_sheets_include = tk.StringVar(value="")
        v.var_sheets_exclude = tk.StringVar(value="")
        v.var_keep_orig = tk.BooleanVar(value=True)

        # Recalcular estimación cuando cambien los valores clave.
        for var in (v.var_fps, v.var_cols, v.var_rows, v.var_start, v.var_end,
                    v.var_range_mode, v.var_extract_mode, v.var_include,
                    v.var_exclude, v.var_source):
            var.trace_add("write", lambda *_: self._update_estimate())

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        # La BARRA DE ACCIÓN se empaqueta PRIMERO y anclada abajo: con pack,
        # los primeros en empaquetarse tienen prioridad de espacio. Si las
        # pestañas piden más alto del que hay en pantalla, el que se encoge es
        # el notebook — los botones (Vista previa / Generar hojas) quedan
        # SIEMPRE visibles. (Antes la barra iba al final y en pantallas bajas
        # desaparecía entera.)
        bar = ttk.Frame(self, padding=(PAD, 0, PAD, 0))
        bar.pack(side="bottom", fill="x")
        self.estimate_lbl = ttk.Label(bar, text="", style="Info.TLabel")
        self.estimate_lbl.pack(anchor="w", pady=(0, 4))
        self.progress = ttk.Progressbar(bar, mode="determinate")
        self.progress.pack(fill="x")
        self.status_lbl = ttk.Label(bar, text="Listo.", style="Sub.TLabel")
        self.status_lbl.pack(anchor="w", pady=(2, 6))

        btns = ttk.Frame(bar)
        btns.pack(fill="x")
        self.run_btn = ttk.Button(btns, text="Generar hojas",
                                  style="Accent.TButton", command=self._on_run)
        self.run_btn.pack(side="right")
        self.cancel_btn = ttk.Button(btns, text="Cancelar", command=self._on_cancel,
                                     state="disabled")
        self.cancel_btn.pack(side="right", padx=(0, PAD))
        self.preview_btn = ttk.Button(btns, text="👁  Vista previa",
                                      command=self._on_preview)
        self.preview_btn.pack(side="right", padx=(0, PAD))
        ttk.Button(btns, text="Ayuda", command=self._show_help).pack(side="left")

        # Presets con nombre
        pf = ttk.Frame(btns)
        pf.pack(side="left", padx=(PAD, 0))
        ttk.Label(pf, text="Preset:").pack(side="left")
        self.preset_cb = ttk.Combobox(pf, width=18, values=config.list_presets())
        self.preset_cb.pack(side="left", padx=4)
        ttk.Button(pf, text="Cargar", width=7,
                   command=self._load_preset).pack(side="left")
        ttk.Button(pf, text="Guardar", width=8,
                   command=self._save_preset).pack(side="left", padx=(4, 0))

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=PAD, pady=(0, PAD))
        self._tab_source(nb)
        self._tab_grid(nb)
        self._tab_sheet(nb)
        self._tab_labels(nb)
        self._tab_pagenum(nb)
        self._tab_markers(nb)
        self._tab_cyanotype(nb)
        self._tab_output(nb)
        self.enable_autowrap()

    def _tab_source(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="1 · Origen")

        sec = self.section(tab, "¿De dónde salen los fotogramas?")
        ttk.Radiobutton(sec, text="De un video", variable=self.var_source,
                        value="video", command=self._sync_source).grid(
            row=0, column=0, sticky="w")
        ttk.Radiobutton(sec, text="De una carpeta de imágenes (frames ya "
                                  "exportados, dibujos, etc.)",
                        variable=self.var_source, value="folder",
                        command=self._sync_source).grid(
            row=1, column=0, columnspan=2, sticky="w")

        self.video_sec = self.section(tab, "Archivo de video")
        ttk.Entry(self.video_sec, textvariable=self.var_video).grid(
            row=0, column=0, columnspan=2, sticky="ew", padx=(0, PAD))
        self.video_browse_btn = ttk.Button(self.video_sec, text="Examinar…",
                                           command=self._pick_video)
        self.video_browse_btn.grid(row=0, column=2)
        self.video_info_lbl = ttk.Label(self.video_sec,
                                        text="Aún no se ha cargado ningún video.",
                                        style="Sub.TLabel")
        self.video_info_lbl.grid(row=1, column=0, columnspan=3, sticky="w", pady=(6, 0))

        self.range_sec = self.section(tab, "Rango a procesar (solo video)")
        ttk.Radiobutton(self.range_sec, text="Todo el video",
                        variable=self.var_range_mode,
                        value="all", command=self._sync_range).grid(
            row=0, column=0, columnspan=3, sticky="w")
        ttk.Radiobutton(self.range_sec, text="Elegir inicio y fin (en segundos)",
                        variable=self.var_range_mode, value="range",
                        command=self._sync_range).grid(row=1, column=0,
                                                       columnspan=3, sticky="w")
        self.range_box = ttk.Frame(self.range_sec)
        self.range_box.grid(row=2, column=0, columnspan=3, sticky="ew", pady=(4, 0))
        ttk.Label(self.range_box, text="Inicio (s):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(self.range_box, from_=0, to=999999, increment=0.5, width=10,
                    textvariable=self.var_start).grid(row=0, column=1, padx=(4, PAD * 2))
        ttk.Label(self.range_box, text="Fin (s):").grid(row=0, column=2, sticky="w")
        ttk.Spinbox(self.range_box, from_=0, to=999999, increment=0.5, width=10,
                    textvariable=self.var_end).grid(row=0, column=3, padx=4)

        self.folder_sec = self.section(tab, "Carpeta de imágenes")
        ttk.Entry(self.folder_sec, textvariable=self.var_frames_dir).grid(
            row=0, column=0, columnspan=2, sticky="ew", padx=(0, PAD))
        self.folder_browse_btn = ttk.Button(self.folder_sec, text="Examinar…",
                                            command=self._pick_frames_dir)
        self.folder_browse_btn.grid(row=0, column=2)
        self.folder_info_lbl = ttk.Label(self.folder_sec, text="",
                                         style="Sub.TLabel")
        self.folder_info_lbl.grid(row=1, column=0, columnspan=3, sticky="w",
                                  pady=(6, 0))

        self._sync_range()
        self._sync_source()

    def _tab_grid(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="2 · Fotogramas")

        sec = self.section(tab, "¿Cuántos fotogramas extraer del video?")
        self.extract_sec = sec
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

        sec = self.section(tab, "Imágenes por hoja (cuadrícula)")
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
        ttk.Label(sec, text="Para mixed media clásico usa 2 columnas × 2 filas "
                            "(4 por hoja).", style="Sub.TLabel").grid(
            row=2, column=0, columnspan=2, sticky="w")

        sec = self.section(tab, "Elegir qué fotogramas salen (opcional)")
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

        sec = self.section(tab, "Fotogramas repetidos (ahorra papel y pintura)")
        ttk.Checkbutton(sec, text="Detectar dibujos repetidos e imprimir solo "
                                  "uno por grupo (se reutilizan al armar el video)",
                        variable=self.var_dedup).grid(row=0, column=0,
                                                      columnspan=3, sticky="w")
        db = ttk.Frame(sec)
        db.grid(row=1, column=0, columnspan=3, sticky="w", padx=(20, 0), pady=(4, 0))
        ttk.Label(db, text="Tolerancia:").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(db, from_=0, to=16, width=6,
                    textvariable=self.var_dedup_thr).grid(row=0, column=1, padx=4)
        ttk.Label(db, text="0 = solo idénticos · 4 = tolera ruido de video "
                           "(recomendado) · más = agrupa parecidos",
                  style="Sub.TLabel").grid(row=0, column=2, sticky="w", padx=(6, 0))

        sec = self.section(tab, "Espaciado entre frames")
        ttk.Label(sec, text="Separación entre imágenes (mm):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(sec, from_=0, to=100, increment=0.5, width=8,
                    textvariable=self.var_gutter).grid(row=0, column=1, sticky="w", padx=4)

    def _tab_sheet(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="3 · Hoja")

        sec = self.section(tab, "Tamaño y orientación")
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

        sec = self.section(tab, "Calidad y márgenes")
        ttk.Label(sec, text="Resolución (DPI):").grid(row=0, column=0, sticky="w")
        ttk.Spinbox(sec, from_=72, to=1200, increment=10, width=8,
                    textvariable=self.var_dpi).grid(row=0, column=1, sticky="w", padx=4)
        ttk.Label(sec, text="(300 = calidad de impresión)", style="Sub.TLabel").grid(
            row=0, column=2, sticky="w")
        ttk.Label(sec, text="Margen de la hoja (mm):").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=0, to=100, increment=0.5, width=8,
                    textvariable=self.var_margin).grid(row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Color de fondo:").grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.color_picker(sec, self.var_bg, row=2, col=1)

        sec = self.section(tab, "Perfil de impresora (de la fase ① Calibración)")
        ttk.Label(sec, text="Perfil:").grid(row=0, column=0, sticky="w")
        self.printer_cb = ttk.Combobox(sec, textvariable=self.var_printer_profile,
                                       state="readonly", width=26,
                                       values=[NO_PRINTER])
        self.printer_cb.grid(row=0, column=1, sticky="w", padx=4)
        ttk.Button(sec, text="Aplicar tamaños recomendados",
                   command=self._apply_printer_sizes).grid(row=0, column=2, padx=4)
        ttk.Label(sec, text="Con un perfil activo se compensa la escala real de "
                            "tu impresora y puedes usar los tamaños de marcador/QR "
                            "que se midieron como seguros.",
                  style="Sub.TLabel", wraplength=720).grid(
            row=1, column=0, columnspan=3, sticky="w", pady=(6, 0))

    def _tab_labels(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="4 · Nombres")

        sec = self.section(tab, "Etiquetas de los fotogramas")
        ttk.Checkbutton(sec, text="Escribir el nombre debajo de cada frame",
                        variable=self.var_labels_on,
                        command=self._update_name_preview).grid(row=0, column=0, columnspan=4, sticky="w")
        ttk.Label(sec, text="Fuente del nombre:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Combobox(sec, values=LABEL_SOURCES, textvariable=self.var_label_source,
                     state="readonly", width=32).grid(
            row=1, column=1, columnspan=3, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="«Nombre del archivo» es útil con carpetas de "
                            "imágenes (conserva CLIP018, CLIP019…).",
                  style="Sub.TLabel").grid(row=2, column=0, columnspan=4, sticky="w")
        ttk.Label(sec, text="Nombre base:").grid(row=3, column=0, sticky="w", pady=(6, 0))
        e = ttk.Entry(sec, textvariable=self.var_base, width=18)
        e.grid(row=3, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Separador:").grid(row=3, column=2, sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_sep, width=6).grid(row=3, column=3, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Dígitos (ceros a la izq.):").grid(row=4, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=1, to=8, width=6, textvariable=self.var_zeros,
                    command=self._update_name_preview).grid(row=4, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Empezar en:").grid(row=4, column=2, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=0, to=999999, width=8, textvariable=self.var_startidx,
                    command=self._update_name_preview).grid(row=4, column=3, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Numeración:").grid(row=5, column=0, sticky="w", pady=(6, 0))
        ttk.Combobox(sec, values=core.NUMBERING, textvariable=self.var_numbering,
                     state="readonly", width=28).grid(
            row=5, column=1, columnspan=3, sticky="w", padx=4, pady=(6, 0))
        for var in (self.var_base, self.var_sep, self.var_zeros, self.var_startidx,
                    self.var_numbering, self.var_label_source):
            var.trace_add("write", lambda *_: self._update_name_preview())
        self.name_preview = ttk.Label(sec, text="", style="Info.TLabel")
        self.name_preview.grid(row=6, column=0, columnspan=4, sticky="w", pady=(8, 0))
        ttk.Checkbutton(
            sec, text="Usar el nombre del video automáticamente (nombre base y archivos)",
            variable=self.var_autoname, command=self._apply_autoname).grid(
            row=7, column=0, columnspan=4, sticky="w", pady=(8, 0))

        sec = self.section(tab, "Tipografía de los nombres")
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
        self.color_picker(sec, self.var_label_color, row=3, col=1)

    def _tab_pagenum(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="5 · Nº de hoja")

        sec = self.section(tab, "Número de hoja en la esquina")
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
        ttk.Label(sec, text="Orden al incluir/excluir:").grid(
            row=4, column=0, sticky="w", pady=(6, 0))
        ttk.Combobox(sec, values=core.PAGE_NUMBERING, textvariable=self.var_pagenum_order,
                     state="readonly", width=28).grid(
            row=4, column=1, columnspan=3, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Tamaño de fuente (pt):").grid(row=5, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=4, to=72, increment=0.5, width=8,
                    textvariable=self.var_pagenum_size).grid(row=5, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Color:").grid(row=6, column=0, sticky="w", pady=(6, 0))
        self.color_picker(sec, self.var_pagenum_color, row=6, col=1)

    def _tab_markers(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="6 · Marcadores")

        sec = self.section(tab, "Marcadores de registro (para escanear de vuelta)",
                           guide="marcadores")
        ttk.Checkbutton(
            sec, text="Añadir marcadores ArUco + códigos QR (necesario para la "
                      "fase ③ Procesar escaneos)",
            variable=self.var_reg_on).grid(row=0, column=0, columnspan=4, sticky="w")
        ttk.Label(sec, text="Al activarlos también se guarda un archivo "
                            "layout .json junto a las hojas: NO lo borres, es "
                            "el mapa que usa el procesador de escaneos.",
                  style="Sub.TLabel", wraplength=740).grid(
            row=1, column=0, columnspan=4, sticky="w", pady=(4, 6))

        ttk.Label(sec, text="Cantidad de marcadores:").grid(row=2, column=0, sticky="w")
        ttk.Combobox(sec, values=[str(c) for c in markers.MARKER_COUNTS],
                     textvariable=self.var_marker_count, state="readonly",
                     width=6).grid(row=2, column=1, sticky="w", padx=4)
        ttk.Label(sec, text="8 recomendado: la hoja se procesa aunque fallen "
                            "hasta 5; con 12, hasta 9.",
                  style="Sub.TLabel").grid(row=2, column=2, columnspan=2, sticky="w")

        ttk.Label(sec, text="Tamaño del marcador (mm):").grid(row=3, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=4, to=25, increment=0.5, width=8,
                    textvariable=self.var_marker_size).grid(row=3, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Margen al borde (mm):").grid(row=3, column=2, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=2, to=20, increment=0.5, width=8,
                    textvariable=self.var_marker_margin).grid(row=3, column=3, sticky="w", padx=4, pady=(6, 0))

        sec = self.section(tab, "Códigos QR (identifican cada fotograma)")
        ttk.Checkbutton(sec, text="Añadir un QR debajo de cada fotograma "
                                  "(recomendado: identifica las hojas escaneadas "
                                  "en cualquier orden)",
                        variable=self.var_qr_on).grid(row=0, column=0,
                                                      columnspan=3, sticky="w")
        ttk.Label(sec, text="Tamaño del QR (mm):").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Spinbox(sec, from_=6, to=30, increment=0.5, width=8,
                    textvariable=self.var_qr_size).grid(row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Label(sec, text="Nombre del proyecto (va dentro de los QR):").grid(
            row=2, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_project, width=24).grid(
            row=2, column=1, columnspan=2, sticky="w", padx=4, pady=(6, 0))

        sec = self.section(tab, "Extras")
        ttk.Checkbutton(sec, text="Tira de parches de grises en el borde (permite "
                                  "normalizar niveles del escáner, opcional)",
                        variable=self.var_patch_on).grid(row=0, column=0, sticky="w")
        ttk.Label(sec, text="Consejo de flujo: cubre los marcadores y QRs con "
                            "cinta de enmascarar antes de pintar y retírala antes "
                            "de escanear. Con 8+ marcadores, no pasa nada si "
                            "algunos quedan dañados.",
                  style="Sub.TLabel", wraplength=740).grid(
            row=1, column=0, sticky="w", pady=(6, 0))

    def _tab_cyanotype(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="7 · Cianotipia")

        sec = self.section(tab, "Negativos para cianotipia (imprimir en acetato)",
                           guide="cianotipia")
        ttk.Checkbutton(
            sec, text="MODO CIANOTIPIA: generar las hojas como NEGATIVOS para "
                      "acetato ☀️",
            variable=self.var_cyan_on).grid(row=0, column=0, columnspan=3, sticky="w")
        ttk.Label(sec, text="Cada hoja sale invertida (negativo), con los "
                            "marcadores, QRs y nombres también invertidos: al "
                            "exponer la cianotipia al sol, todo queda con la "
                            "polaridad correcta y el escaneo de la copia azul "
                            "se procesa normalmente en la fase ③.",
                  style="Sub.TLabel", wraplength=740).grid(
            row=1, column=0, columnspan=3, sticky="w", pady=(4, 6))

        ttk.Checkbutton(sec, text="Espejar la hoja (imprimir en espejo, para "
                                  "exponer emulsión contra emulsión — recomendado)",
                        variable=self.var_cyan_mirror).grid(
            row=2, column=0, columnspan=3, sticky="w")
        bb = ttk.Frame(sec)
        bb.grid(row=3, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(bb, text="Borde bloqueador alrededor de cada frame (mm):").pack(side="left")
        ttk.Spinbox(bb, from_=0.0, to=1.0, increment=0.1, width=6,
                    textvariable=self.var_cyan_border).pack(side="left", padx=4)
        ttk.Label(bb, text="marco de tinta a densidad máxima: evita que la luz "
                           "se cuele por los cantos y vele los bordes (0 = sin borde)",
                  style="Sub.TLabel").pack(side="left")

        sec = self.section(tab, "Fondo del negativo (consumo de tinta)")
        ttk.Radiobutton(
            sec, text="AHORRO DE TINTA: fondo transparente; solo los marcadores, "
                      "QRs y nombres llevan un halo entintado (el fondo de la "
                      "cianotipia queda AZUL)",
            variable=self.var_cyan_bg, value="ahorro").grid(
            row=0, column=0, columnspan=3, sticky="w")
        ttk.Radiobutton(
            sec, text="Fondo COMPLETO: toda la zona muerta entintada (gasta mucha "
                      "más tinta; el fondo de la cianotipia queda BLANCO papel)",
            variable=self.var_cyan_bg, value="completo").grid(
            row=1, column=0, columnspan=3, sticky="w", pady=(2, 0))
        hh = ttk.Frame(sec)
        hh.grid(row=2, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(hh, text="Halo entintado alrededor de marcadores/QRs/nombres (mm):").pack(side="left")
        ttk.Spinbox(hh, from_=1.0, to=10.0, increment=0.5, width=6,
                    textvariable=self.var_cyan_halo).pack(side="left", padx=4)
        bk = ttk.Frame(sec)
        bk.grid(row=3, column=0, columnspan=3, sticky="w", pady=(6, 0))
        # OJO: color_picker usa grid; dentro de un mismo frame no se puede
        # mezclar pack y grid (TclError al arrancar la app).
        ttk.Checkbutton(bk, text="Color del bloqueador personalizado:",
                        variable=self.var_cyan_block_on).grid(
            row=0, column=0, sticky="w")
        self.color_picker(bk, self.var_cyan_block_color, row=0, col=1)
        ttk.Label(sec, text="Lo externo a los fotogramas (fondo completo, halos "
                            "y borde bloqueador) se imprime por defecto con la "
                            "tinta a DENSIDAD MÁXIMA — con un degradado "
                            "ColorBlocker eso es negro puro, y hay impresoras "
                            "que imprimen mal los campos grandes de negro "
                            "100 %. Aquí eliges un color denso que tu "
                            "impresora sí imprima bien.",
                  style="Sub.TLabel", wraplength=740).grid(
            row=4, column=0, columnspan=3, sticky="w", pady=(2, 0))

        sec = self.section(tab, "Color de la tinta del negativo")
        ik = ttk.Frame(sec)
        ik.grid(row=0, column=0, columnspan=3, sticky="w")
        ttk.Label(ik, text="Color simple:").grid(row=0, column=0)
        self.color_picker(ik, self.var_cyan_ink, row=0, col=1)
        cp = ttk.Frame(sec)
        cp.grid(row=1, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(cp, text="Perfil de color (ColorBlocker):").pack(side="left")
        self.colorprofile_cb = ttk.Combobox(cp, textvariable=self.var_cyan_colorprofile,
                                            state="readonly", width=26,
                                            values=[NO_COLOR_PROFILE])
        self.colorprofile_cb.pack(side="left", padx=4)
        ttk.Label(sec, text="El negro no siempre es lo que mejor bloquea el UV. "
                            "El perfil ColorBlocker (fase ①, método "
                            "easydigitalnegatives.com) usa el color/degradado "
                            "medido como MEJOR bloqueador en TU impresora; si "
                            "eliges uno, reemplaza al color simple.",
                  style="Sub.TLabel", wraplength=740).grid(
            row=2, column=0, columnspan=3, sticky="w", pady=(2, 0))

        sec = self.section(tab, "Curva de compensación (calibración)")
        ttk.Label(sec, text="Curva:").grid(row=0, column=0, sticky="w")
        self.curve_cb = ttk.Combobox(sec, textvariable=self.var_cyan_curve,
                                     state="readonly", width=28,
                                     values=[NO_CURVE])
        self.curve_cb.grid(row=0, column=1, sticky="w", padx=4)
        ttk.Label(sec, text="Se crea en la fase ① (Calibración → Cianotipia). "
                            "Lineariza los tonos y aprovecha todo el rango "
                            "dinámico de TU proceso (impresora + acetato + "
                            "química + sol).",
                  style="Sub.TLabel", wraplength=740).grid(
            row=1, column=0, columnspan=3, sticky="w", pady=(6, 0))

        sec = self.section(tab, "Vista previa")
        ttk.Checkbutton(sec, text="En la vista previa, simular la copia azul "
                                  "final en vez del negativo",
                        variable=self.var_cyan_sim).grid(row=0, column=0, sticky="w")

    def _tab_output(self, nb):
        tab = ttk.Frame(nb, padding=PAD)
        nb.add(tab, text="8 · Salida")

        sec = self.section(tab, "Dónde guardar")
        ttk.Label(sec, text="Carpeta de salida:").grid(row=0, column=0, sticky="w")
        ttk.Entry(sec, textvariable=self.var_out_dir).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(sec, text="Examinar…", command=self._pick_outdir).grid(row=0, column=2)
        ttk.Label(sec, text="Nombre de los archivos:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_out_name, width=28).grid(
            row=1, column=1, sticky="w", padx=4, pady=(6, 0))

        sec = self.section(tab, "Formatos a generar")
        ttk.Checkbutton(sec, text="PNG por hoja (sin pérdida, recomendado)",
                        variable=self.var_png).grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(sec, text="PDF combinado (ideal para imprimir)",
                        variable=self.var_pdf).grid(row=1, column=0, sticky="w")
        ttk.Checkbutton(sec, text="TIFF por hoja (sin pérdida, archivo grande)",
                        variable=self.var_tiff).grid(row=2, column=0, sticky="w")
        ttk.Checkbutton(sec, text="Además, guardar cada fotograma individual a máxima calidad (PNG con su nombre)",
                        variable=self.var_export_frames).grid(row=3, column=0, sticky="w", pady=(6, 0))
        ttk.Checkbutton(sec, text="Guardar copia de los fotogramas originales "
                                  "(necesario para las hojas de rescate)",
                        variable=self.var_keep_orig).grid(row=4, column=0, sticky="w", pady=(2, 0))

        sec = self.section(tab, "Qué hojas producir")
        gb = ttk.Frame(sec)
        gb.grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(gb, text="Generar solo las hojas:").grid(row=0, column=0, sticky="w")
        ttk.Entry(gb, textvariable=self.var_sheets_include, width=18).grid(
            row=0, column=1, sticky="w", padx=4)
        ttk.Label(gb, text="Excluir hojas:").grid(row=0, column=2, sticky="w", padx=(PAD, 0))
        ttk.Entry(gb, textvariable=self.var_sheets_exclude, width=18).grid(
            row=0, column=3, sticky="w", padx=4)
        ttk.Label(sec, text='Por número de hoja, p. ej. "3, 5-7" (vacío = todas). '
                            "Perfecto para reimprimir una hoja dañada sin "
                            "regenerar todo (el layout .json sigue describiendo "
                            "todas).",
                  style="Sub.TLabel", wraplength=740).grid(
            row=1, column=0, columnspan=2, sticky="w", pady=(6, 0))

    # ----------------------------------------------------------- fuentes
    def _load_fonts_async(self):
        def work():
            fmap = fontmod.discover_fonts()
            self.queue.put(("fonts", fmap))
        threading.Thread(target=work, daemon=True).start()

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

    # ----------------------------------------------------------- perfiles
    def refresh_profiles(self):
        printers = [NO_PRINTER] + config.list_profiles("impresora")
        self.printer_cb.configure(values=printers)
        if self.var_printer_profile.get() not in printers:
            self.var_printer_profile.set(NO_PRINTER)
        curves = [NO_CURVE] + config.list_profiles("cianotipia")
        self.curve_cb.configure(values=curves)
        if self.var_cyan_curve.get() not in curves:
            self.var_cyan_curve.set(NO_CURVE)
        colors = [NO_COLOR_PROFILE] + config.list_profiles("cianotipia_color")
        self.colorprofile_cb.configure(values=colors)
        if self.var_cyan_colorprofile.get() not in colors:
            self.var_cyan_colorprofile.set(NO_COLOR_PROFILE)

    def _cyan_color_profile(self) -> dict | None:
        name = self.var_cyan_colorprofile.get()
        if not name or name == NO_COLOR_PROFILE:
            return None
        return config.load_profile("cianotipia_color", name)

    def _printer_profile(self) -> dict | None:
        name = self.var_printer_profile.get()
        if not name or name == NO_PRINTER:
            return None
        return config.load_profile("impresora", name)

    def _cyan_curve_lut(self):
        name = self.var_cyan_curve.get()
        if not name or name == NO_CURVE:
            return None
        prof = config.load_profile("cianotipia", name)
        return prof.get("lut") if prof else None

    def _apply_printer_sizes(self):
        prof = self._printer_profile()
        if not prof:
            messagebox.showinfo("Perfil de impresora",
                                "Elige primero un perfil (se crean en la fase "
                                "③ Calibración).")
            return
        if prof.get("marker_recomendado_mm"):
            self.var_marker_size.set(float(prof["marker_recomendado_mm"]))
        if prof.get("qr_recomendado_mm"):
            self.var_qr_size.set(float(prof["qr_recomendado_mm"]))
        messagebox.showinfo(
            "Perfil aplicado",
            f"Marcadores: {self.var_marker_size.get():g} mm · "
            f"QRs: {self.var_qr_size.get():g} mm\n"
            "(medidos como seguros para tu impresora)")

    # ----------------------------------------------------------- presets
    def _save_preset(self):
        name = self.preset_cb.get().strip()
        if not name:
            messagebox.showinfo("Preset", "Escribe un nombre para el preset "
                                          "en el campo de al lado.")
            return
        config.save_preset(name, self.collect_vars("s1_"))
        self.preset_cb.configure(values=config.list_presets())
        self._set_status(f"Preset «{name}» guardado.")

    def _load_preset(self):
        name = self.preset_cb.get().strip()
        data = config.load_preset(name) if name else None
        if not data:
            messagebox.showinfo("Preset", "Elige un preset de la lista.")
            return
        self.restore_vars("s1_", data)
        self._after_restore()
        self._set_status(f"Preset «{name}» cargado.")

    # ----------------------------------------------------------- acciones
    def _pick_video(self):
        path = filedialog.askopenfilename(title="Elegir video", filetypes=VIDEO_TYPES)
        if not path:
            return
        self.var_video.set(path)
        stem = Path(path).stem
        if self.var_autoname.get():
            self.var_out_name.set(stem)
            self.var_base.set(stem)
        elif not self.var_out_name.get() or self.var_out_name.get() == "contact_sheet":
            self.var_out_name.set(stem)
        if not self.var_out_dir.get():
            self.var_out_dir.set(str(Path(path).parent / "contact_sheets"))
        self._probe_async(path)
        self._update_name_preview()

    def _pick_frames_dir(self):
        d = filedialog.askdirectory(title="Carpeta con tus imágenes/fotogramas")
        if not d:
            return
        self.var_frames_dir.set(d)
        frames = self._folder_frames(d)
        self._folder_count = len(frames)
        self.folder_info_lbl.configure(
            text=f"{len(frames)} imagen(es) encontradas."
            if frames else "No se encontraron imágenes en esa carpeta.")
        if self.var_autoname.get():
            stem = Path(d).name
            self.var_out_name.set(stem)
            self.var_base.set(stem)
        if not self.var_out_dir.get():
            self.var_out_dir.set(str(Path(d).parent / "contact_sheets"))
        self._update_estimate()

    @staticmethod
    def _folder_frames(d):
        try:
            return sorted(str(p) for p in Path(d).iterdir()
                          if p.is_file() and p.suffix.lower() in IMG_EXTS)
        except OSError:
            return []

    def _apply_autoname(self):
        """Si el nombre automático está activo y hay origen, rellena los nombres."""
        if not self.var_autoname.get():
            return
        if self.var_source.get() == "video" and self.var_video.get():
            stem = Path(self.var_video.get()).stem
        elif self.var_source.get() == "folder" and self.var_frames_dir.get():
            stem = Path(self.var_frames_dir.get()).name
        else:
            return
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

    def _sync_source(self):
        video = self.var_source.get() == "video"
        for sec, on in ((self.video_sec, video), (self.range_sec, video),
                        (self.folder_sec, not video)):
            for child in sec.winfo_children():
                try:
                    child.configure(state="normal" if on else "disabled")
                except tk.TclError:
                    pass
        if video:
            self._sync_range()
        if hasattr(self, "extract_sec"):
            for child in self.extract_sec.winfo_children():
                try:
                    child.configure(state="normal" if video else "disabled")
                except tk.TclError:
                    pass
            if video:
                self._sync_extract()
        self._update_estimate()

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

    def _after_restore(self):
        self._sync_range()
        self._sync_extract()
        self._sync_custom()
        self._sync_source()
        self._update_name_preview()

    def _update_name_preview(self):
        if not self.var_labels_on.get():
            self.name_preview.configure(text="(nombres desactivados)")
            return
        if self.var_label_source.get() == LABEL_SOURCES[1]:
            self.name_preview.configure(
                text="Ejemplo:  el nombre de cada archivo (CLIP018, CLIP019, …)")
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
            leading_zeros=self.to_int(self.var_zeros, 1),
            start_index=self.to_int(self.var_startidx, 1),
        )

    # ----------------------------------------------------------- estimación
    def _selected_range(self):
        if self.var_range_mode.get() == "range":
            start = max(0.0, self.to_float(self.var_start, 0.0))
            end = self.to_float(self.var_end, 0.0)
            if end <= start and self.video_info.duration:
                end = self.video_info.duration
            return start, (end if end > start else None)
        # Todo el video
        return 0.0, (self.video_info.duration or None)

    def _update_estimate(self, *_):
        if not hasattr(self, "estimate_lbl"):
            return
        per_page = max(1, self.to_int(self.var_cols, 1) * self.to_int(self.var_rows, 1))
        if hasattr(self, "perpage_lbl"):
            self.perpage_lbl.configure(text=f"= {per_page} imágenes por hoja")

        frames = None
        if self.var_source.get() == "folder":
            frames = self._folder_count or None
        else:
            start, end = self._selected_range()
            if self.var_extract_mode.get() == "fps":
                fps = self.to_float(self.var_fps, 0)
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
            extra = "  ·  los repetidos se descuentan al generar" \
                if self.var_dedup.get() else ""
            self.estimate_lbl.configure(
                text=f"≈ {frames} fotogramas{sel_txt}  →  {pages} hoja(s)  "
                     f"({per_page} por hoja){extra}")
        else:
            origen = ("elige una carpeta" if self.var_source.get() == "folder"
                      else "carga un video")
            self.estimate_lbl.configure(
                text=f"{per_page} imágenes por hoja  ·  {origen} para estimar el total")

    # ----------------------------------------------------------- ejecutar
    def _collect_settings(self) -> core.Settings:
        prof = self._printer_profile() or {}
        color_prof = self._cyan_color_profile() or {}
        cyan_ink = color_prof.get("mejor_color") or self.var_cyan_ink.get()
        return core.Settings(
            paper=self.var_paper.get(), orientation=self.var_orientation.get(),
            dpi=self.to_int(self.var_dpi, 300),
            custom_w_mm=self.to_float(self.var_custom_w, 210),
            custom_h_mm=self.to_float(self.var_custom_h, 297),
            margin_mm=self.to_float(self.var_margin, 10),
            gutter_mm=self.to_float(self.var_gutter, 5),
            bg_color=self.var_bg.get(),
            cols=self.to_int(self.var_cols, 4), rows=self.to_int(self.var_rows, 5),
            labels_on=self.var_labels_on.get(), base_name=self.var_base.get(),
            separator=self.var_sep.get(), leading_zeros=self.to_int(self.var_zeros, 1),
            start_index=self.to_int(self.var_startidx, 1), font_path=self._font_path(),
            font_size_pt=self.to_float(self.var_font_size, 9),
            label_gap_mm=self.to_float(self.var_label_gap, 1.5),
            label_color=self.var_label_color.get(),
            page_num_on=self.var_pagenum_on.get(),
            page_num_corner=self.var_pagenum_corner.get(),
            page_num_prefix=self.var_pagenum_prefix.get(),
            page_num_start=self.to_int(self.var_pagenum_start, 1),
            page_num_zeros=self.to_int(self.var_pagenum_zeros, 1),
            page_num_size_pt=self.to_float(self.var_pagenum_size, 11),
            page_num_color=self.var_pagenum_color.get(),
            registration_on=self.var_reg_on.get(),
            marker_count=self.to_int(self.var_marker_count, 8),
            marker_size_mm=self.to_float(self.var_marker_size, 8.0),
            marker_margin_mm=self.to_float(self.var_marker_margin, 4.0),
            qr_on=self.var_qr_on.get(),
            qr_size_mm=self.to_float(self.var_qr_size, 10.0),
            gray_patch_on=self.var_patch_on.get(),
            project_name=self.var_project.get().strip() or self.var_out_name.get(),
            mode="cianotipia" if self.var_cyan_on.get() else "normal",
            cyan_mirror=self.var_cyan_mirror.get(),
            cyan_ink=cyan_ink,
            cyan_curve=self._cyan_curve_lut(),
            cyan_bg=self.var_cyan_bg.get(),
            cyan_halo_mm=self.to_float(self.var_cyan_halo, 5.0),
            cyan_frame_border_mm=self.to_float(self.var_cyan_border, 0.8),
            cyan_block_color=(self.var_cyan_block_color.get()
                              if self.var_cyan_block_on.get() else None),
            cyan_ink_stops=color_prof.get("stops"),
            print_scale_x=float(prof.get("scale_x", 1.0) or 1.0),
            print_scale_y=float(prof.get("scale_y", 1.0) or 1.0),
            out_dir=self.var_out_dir.get(), out_name=self.var_out_name.get() or "contact_sheet",
            fmt_png=self.var_png.get(), fmt_pdf=self.var_pdf.get(),
            fmt_tiff=self.var_tiff.get(), export_frames=self.var_export_frames.get(),
            sheets_include=self.var_sheets_include.get(),
            sheets_exclude=self.var_sheets_exclude.get(),
            keep_originals=self.var_keep_orig.get(),
        )

    def _validate(self, s: core.Settings):
        if self.var_source.get() == "video":
            if not self.var_video.get() or not Path(self.var_video.get()).exists():
                return "Elige primero un archivo de video válido (pestaña 1)."
            if self.var_extract_mode.get() == "fps" and self.to_float(self.var_fps, 0) <= 0:
                return "El valor de fps debe ser mayor que 0."
        else:
            d = self.var_frames_dir.get()
            if not d or not Path(d).is_dir():
                return "Elige una carpeta de imágenes válida (pestaña 1)."
            if not self._folder_frames(d):
                return "La carpeta elegida no contiene imágenes."
        if not s.out_dir:
            return "Elige una carpeta de salida (pestaña 8 · Salida)."
        if not (s.fmt_png or s.fmt_pdf or s.fmt_tiff):
            return "Selecciona al menos un formato de salida (pestaña 8)."
        return None

    def _job_params(self):
        start, end = self._selected_range()
        return {
            "source": self.var_source.get(),
            "video": self.var_video.get(),
            "frames_dir": self.var_frames_dir.get(),
            "start": start, "end": end,
            "fps": (self.to_float(self.var_fps, 0)
                    if self.var_extract_mode.get() == "fps" else None),
            "include": self.var_include.get(),
            "exclude": self.var_exclude.get(),
            "numbering_original": self.var_numbering.get().lower().startswith("original"),
            "page_numbering_original": self.var_pagenum_order.get().lower().startswith("original"),
            "label_from_file": self.var_label_source.get() == LABEL_SOURCES[1],
            "dedup": self.var_dedup.get(),
            "dedup_thr": self.to_int(self.var_dedup_thr, 4),
            "simulate_cyan": self.var_cyan_sim.get(),
        }

    def _on_run(self):
        s = self._collect_settings()
        err = self._validate(s)
        if err:
            messagebox.showwarning("Falta algo", err)
            return
        # Cianotipia sin calibrar: ofrecer la hoja de calibración primero.
        if self.var_cyan_on.get() and self.var_cyan_curve.get() == NO_CURVE:
            r = messagebox.askyesnocancel(
                "Cianotipia sin calibrar",
                "No has elegido una curva de calibración de cianotipia, así "
                "que los tonos pueden salir aplastados.\n\n"
                "¿Quieres ir a la fase ① Calibración para generar e imprimir "
                "primero una hoja de calibración (tira Kamiru, carta EDN 2.2 "
                "o ColorBlocker)?\n\n"
                "Sí = ir a Calibración   ·   No = continuar sin curva")
            if r is None:
                return
            if r:
                self.app.goto_calibration()
                return
        self._set_busy(True)
        self.progress.configure(value=0, maximum=100)
        self._set_status("Preparando…")
        self.start_worker(self._work, s, self._job_params())

    # ------------------------------------------------ preparación compartida
    def _prepare_frames(self, s, params, max_frames=None):
        """Extrae/lista los fotogramas y aplica selección, etiquetas y dedup.

        Corre en el hilo de trabajo: los ajustes (s) ya vienen recogidos desde
        el hilo principal (las variables de Tk no deben tocarse desde aquí).

        Devuelve dict con: rep_paths, rep_labels, positions, labels, timeline,
        page_numbers, total_sel, tmpdir (o None), truncated, video_meta.
        """
        tmp = None
        if params["source"] == "video":
            ff = find_ffmpeg()
            tmp = tempfile.mkdtemp(prefix="kamiru_")
            self.queue.put(("status", "Extrayendo fotogramas del video…"))
            frames = extract_frames(
                ff, params["video"], tmp,
                start=params["start"], end=params["end"], fps=params["fps"],
                progress_cb=lambda d, t: self.queue.put(("extract", d, t)),
                cancel_check=self.cancelled, max_frames=max_frames,
            )
            origen = Path(params["video"]).name
            fps_meta = params["fps"] or self.video_info.fps or None
        else:
            frames = self._folder_frames(params["frames_dir"])
            if max_frames:
                frames = frames[:max_frames]
            if not frames:
                raise ValueError("La carpeta elegida no contiene imágenes.")
            origen = Path(params["frames_dir"]).name
            fps_meta = None

        positions = core.select_indices(len(frames), params["include"],
                                        params["exclude"])
        if not positions:
            raise ValueError(
                "La selección de «Incluir/Excluir» (pestaña 2) no deja "
                "ningún fotograma. Revisa esos campos.")
        sel = [frames[i - 1] for i in positions]

        # Etiquetas de TODOS los seleccionados.
        if params["label_from_file"]:
            # Dos archivos distintos pueden compartir el nombre sin extensión
            # ('toma.png' y 'toma.jpg'); se desambigua ANTES de deduplicar y de
            # armar la línea de tiempo para que layout, timeline y archivos
            # exportados usen todos la misma etiqueta única.
            labels = core.uniquify_labels([Path(p).stem for p in sel])
        elif params["numbering_original"]:
            labels = [s.format_label(p) for p in positions]
        else:
            labels = [s.label_for(i) for i in range(len(sel))]

        # Deduplicación perceptual.
        if params["dedup"]:
            self.queue.put(("status", "Buscando dibujos repetidos…"))
            rep_idx, rep_of = dedup.find_duplicates(
                sel, threshold=params["dedup_thr"],
                cancel_check=self.cancelled)
        else:
            rep_idx = list(range(len(sel)))
            rep_of = list(range(len(sel)))

        rep_paths = [sel[i] for i in rep_idx]
        rep_labels = [labels[i] for i in rep_idx]
        rep_positions = [positions[i] for i in rep_idx]

        page_numbers = None
        if params["page_numbering_original"]:
            page_numbers = core.original_page_numbers(
                rep_positions, s.per_page, s.page_num_start)

        timeline = [{"pos": positions[i], "etiqueta": labels[i],
                     "rep": labels[rep_of[i]]} for i in range(len(sel))]
        video_meta = {"origen": origen}
        if fps_meta:
            video_meta["fps_extraccion"] = float(fps_meta)

        return {
            "settings": s,
            "rep_paths": rep_paths, "rep_labels": rep_labels,
            "positions": positions, "labels": labels,
            "page_numbers": page_numbers, "timeline": timeline,
            "video_meta": video_meta, "total_sel": len(sel),
            "total_frames": len(frames), "tmpdir": tmp,
        }

    def _work(self, s, params):
        tmp = None
        try:
            prep = self._prepare_frames(s, params)
            tmp = prep["tmpdir"]
            n_rep, n_sel = len(prep["rep_paths"]), prep["total_sel"]
            if n_rep != n_sel:
                self.queue.put(("status",
                                f"{n_rep} dibujos únicos de {n_sel} fotogramas "
                                "(los repetidos se reutilizarán). Componiendo hojas…"))
            else:
                self.queue.put(("status", f"{n_rep} fotogramas. Componiendo hojas…"))

            result = core.generate(
                prep["settings"], prep["rep_paths"],
                page_numbers=prep["page_numbers"], labels=prep["rep_labels"],
                timeline=prep["timeline"], video_meta=prep["video_meta"],
                progress_cb=lambda d, t: self.queue.put(("compose", d, t)),
                cancel_check=self.cancelled)
            self.queue.put(("done", result))
        except Exception as e:
            if self.cancelled():
                self.queue.put(("cancelled", None))
            else:
                self.queue.put(("error", str(e)))
        finally:
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)

    # ----------------------------------------------------------- vista previa
    def _on_preview(self):
        s = self._collect_settings()
        err = self._validate(s)
        if err:
            messagebox.showwarning("Falta algo", err)
            return
        self._set_busy(True)
        self.progress.configure(mode="indeterminate")
        self.progress.start(12)
        self._set_status("Preparando vista previa…")
        self.start_worker(self._work_preview, s, self._job_params())

    def _work_preview(self, s, params):
        tmp = None
        keep_tmp = False
        try:
            prep = self._prepare_frames(s, params, max_frames=PREVIEW_ALL_CAP)
            tmp = prep["tmpdir"]
            self.queue.put(("status", "Renderizando vista previa…"))
            first_img, num_pages = core.render_preview(
                s, prep["rep_paths"], 0, labels=prep["rep_labels"],
                page_numbers=prep["page_numbers"],
                simulate_cyanotype=params["simulate_cyan"])
            truncated = prep["total_frames"] >= PREVIEW_ALL_CAP
            keep_tmp = tmp is not None
            self.queue.put(("preview_multi",
                            (first_img, prep["rep_paths"], s, num_pages,
                             len(prep["rep_paths"]), tmp, truncated,
                             prep["rep_labels"], prep["page_numbers"],
                             params["simulate_cyan"])))
        except Exception as e:
            if self.cancelled():
                self.queue.put(("cancelled", None))
            else:
                self.queue.put(("error", str(e)))
        finally:
            if tmp and not keep_tmp:
                shutil.rmtree(tmp, ignore_errors=True)

    def _on_cancel(self):
        self.cancel()
        self._set_status("Cancelando…")

    # ----------------------------------------------------------- cola/eventos
    def _poll_forever(self):
        """La fase 1 sondea siempre (fuentes y probe llegan sin worker)."""
        try:
            while True:
                msg = self.queue.get_nowait()
                self.handle(msg)
        except Exception:
            pass
        self.after(120, self._poll_forever)

    def poll_queue(self):  # el poller permanente ya se encarga
        pass

    def handle(self, msg):
        kind = msg[0]
        if kind == "fonts":
            self._apply_fonts(msg[1])
        elif kind == "probe":
            self._apply_probe(msg[1])
        elif kind == "probe_err":
            self.video_info_lbl.configure(text=f"No se pudo leer el video: {msg[1]}")
        elif kind == "status":
            self._set_status(msg[1])
        elif kind == "log":
            self._set_status(msg[1])
        elif kind == "extract":
            done, total = msg[1], msg[2]
            if total:
                self.progress.configure(mode="determinate", maximum=total,
                                        value=min(done, total))
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
             truncated, labels, page_numbers, simulate) = msg[1]
            self._reset_run()
            self._set_status(f"Vista previa lista ({num_pages} hoja(s)).")
            self._show_multi_preview(first_img, frames, settings, num_pages,
                                     nsel, tmpdir, truncated, labels,
                                     page_numbers, simulate)
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
        n = result.get("num_generated", result.get("num_pages", 0))
        orient = result.get("orientation", "")
        self._set_status(f"¡Listo! Se generaron {n} hoja(s).")
        self.app.save_config()
        extra = ""
        if orient:
            suf = "  (elegida automáticamente)" if self.var_orientation.get().lower().startswith("mejor") else ""
            extra += f"\nOrientación: {orient}{suf}"
        if result.get("grid_swapped"):
            extra += (f"\nCuadrícula usada: {result.get('grid')} (el mejor "
                      "ajuste intercambió columnas×filas para agrandar los "
                      "fotogramas)")
        if result.get("pdf"):
            extra += f"\nPDF: {result['pdf']}"
        if result.get("layout"):
            extra += f"\nLayout para escaneos: {result['layout']}"
            try:
                self.app.scans_phase.suggest(result["layout"])
                self.app.video_phase.var_layout.set(result["layout"])
            except Exception:
                pass
        if result.get("frames_dir"):
            extra += f"\nFotogramas individuales: {result['frames_dir']}"
        for aviso in result.get("avisos", []):
            extra += f"\n⚠ {aviso}"
        fallos = result.get("fallos_originales") or []
        if fallos:
            # Sin copia original no se pueden generar hojas de rescate luego,
            # así que el fallo se avisa en vez de pasar desapercibido.
            extra += (f"\n⚠ No se pudo guardar la copia original de "
                      f"{len(fallos)} fotograma(s); no podrás reimprimirlos "
                      f"como hoja de rescate.")
            for f in fallos[:5]:
                self.log(f"⚠ Copia original fallida — {f}")
        if messagebox.askyesno(
                "¡Hojas generadas! 🎉",
                f"Se crearon {n} hoja(s) en:\n{self.var_out_dir.get()}{extra}\n\n"
                "¿Abrir la carpeta de salida?"):
            self.open_folder(self.var_out_dir.get())

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
                            tmpdir, truncated, labels=None, page_numbers=None,
                            simulate=False):
        """Ventana de vista previa con navegación por TODAS las hojas."""
        try:
            from PIL import ImageTk
        except Exception:
            p = Path(tempfile.mkdtemp(prefix="kamiru_pv_")) / "vista_previa.png"
            first_img.save(p)
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)
            messagebox.showinfo("Vista previa", f"Se guardó la vista previa en:\n{p}")
            self.open_folder(str(p.parent))
            return

        win = tk.Toplevel(self)
        win.title("Vista previa de las hojas")
        win.configure(bg=PALETTE["bg"])
        win.transient(self.app)

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
                img, _ = core.render_preview(settings, frames, k, labels=labels,
                                             page_numbers=page_numbers,
                                             simulate_cyanotype=simulate)
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
            if settings.is_cyanotype:
                note += ("  ·  simulación de la copia azul" if simulate
                         else "  ·  negativo para acetato")
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
            if tmpdir:
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

    # ----------------------------------------------------------- ayuda
    def _show_help(self):
        messagebox.showinfo(
            "Cómo usar Kamiru Studio",
            "FASE ① — CALIBRACIÓN (una sola vez): perfiles de impresora "
            "(escala/tamaños) y de cianotipia (color de tinta y curva de "
            "compensación). Hazla ANTES de generar hojas: el resto de la "
            "app usa estos perfiles. Cada sección tiene un botón «?» con "
            "el paso a paso.\n\n"
            "FASE ② — GENERAR HOJAS\n"
            "1) Origen: un video o una carpeta de imágenes.\n"
            "2) Fotogramas: cuántos extraer, cuadrícula, incluir/excluir y "
            "detección de dibujos repetidos.\n"
            "3) Hoja: tamaño, orientación, DPI, márgenes y perfil de impresora.\n"
            "4) Nombres y 5) Nº de hoja: etiquetas y numeración.\n"
            "6) Marcadores: ArUco + QR para poder escanear de vuelta "
            "(genera el layout .json).\n"
            "7) Cianotipia: negativos para acetato (invertidos, espejados, "
            "con borde bloqueador y curva de calibración).\n"
            "8) Salida: formatos y QUÉ hojas producir (p. ej. «3, 5-7»).\n\n"
            "FASE ③ — PROCESAR ESCANEOS: elige los escaneos + el layout .json "
            "y recupera cada fotograma alineado y recortado. Con informe y "
            "hojas de rescate.\n\n"
            "FASE ④ — VIDEO FINAL: reconstruye el video con los fotogramas "
            "procesados en su orden original.\n\n"
            "Los botones «?» repartidos por la app abren guías paso a paso "
            "de cada parte.")


# ════════════════════════════════════════════════════════════════
# Ventana principal
# ════════════════════════════════════════════════════════════════

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{__app_name__}  v{__version__}")
        self.minsize(980, 860)
        build_style(self)

        head = ttk.Frame(self, padding=(PAD * 2, PAD, PAD * 2, 0))
        head.pack(fill="x")
        fila = ttk.Frame(head)
        fila.pack(fill="x")
        ttk.Label(fila, text="Kamiru Studio", style="Header.TLabel").pack(side="left")
        ttk.Button(fila, text="?  ¿Cómo es el flujo?", style="Help.TButton",
                   command=lambda: show_guide(self, "flujo")).pack(
            side="left", padx=(12, 0))
        ttk.Label(head, text="Hecho con cariño para Kamila 💚  ·  ① calibra → "
                             "② genera hojas → pinta o expón ☀️ → ③ procesa "
                             "escaneos → ④ video  ·  sin Photoshop, sin "
                             "pérdida de calidad",
                  style="Sub.TLabel").pack(anchor="w")

        phases = ttk.Notebook(self, style="Phase.TNotebook")
        phases.pack(fill="both", expand=True, padx=PAD, pady=PAD)
        self.phases_nb = phases
        self.sheets_phase = SheetsPhase(phases, self)
        self.scans_phase = ScansPhase(phases, self)
        self.calib_phase = CalibPhase(phases, self)
        self.video_phase = VideoPhase(phases, self)
        # Calibración PRIMERO: el flujo ideal es calibrar impresora y
        # proceso antes de generar hojas (las demás fases usan sus perfiles).
        # Los prefijos de config (s1_..s4_) se conservan por compatibilidad.
        phases.add(self.calib_phase, text="①  Calibración")
        phases.add(self.sheets_phase, text="②  Generar hojas")
        phases.add(self.scans_phase, text="③  Procesar escaneos")
        phases.add(self.video_phase, text="④  Video final")

        self._restore_config()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._bring_to_front()

    def _bring_to_front(self):
        try:
            self.lift()
            self.attributes("-topmost", True)
            self.after(400, lambda: self.attributes("-topmost", False))
        except tk.TclError:
            pass

    def goto_calibration(self):
        """Salta a la fase ① (usado cuando falta un perfil de calibración)."""
        try:
            self.phases_nb.select(self.calib_phase)
        except tk.TclError:
            pass

    # ----------------------------------------------------------- config
    def save_config(self):
        data = {}
        data.update(self.sheets_phase.collect_vars("s1_"))
        data.update(self.scans_phase.collect_vars("s2_"))
        data.update(self.calib_phase.collect_vars("s3_"))
        data.update(self.video_phase.collect_vars("s4_"))
        config.save(data)

    def _restore_config(self):
        data = config.load()
        if not data:
            return
        self.sheets_phase.restore_vars("s1_", data)
        self.scans_phase.restore_vars("s2_", data)
        self.calib_phase.restore_vars("s3_", data)
        self.video_phase.restore_vars("s4_", data)
        self.sheets_phase._after_restore()

    def _on_close(self):
        try:
            self.save_config()
        finally:
            self.destroy()


def main():
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
