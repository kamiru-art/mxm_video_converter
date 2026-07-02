"""Fases 2-4 de la interfaz: Procesar escaneos, Calibración y Video final."""

from __future__ import annotations

import json
import os
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from . import calibration, config, layoutfile, paper, rescue, scan, videoout
from .gui_common import PAD, PhaseFrame

_IMG_TYPES = [("Imágenes", "*.tif *.tiff *.png *.jpg *.jpeg"),
              ("Todos los archivos", "*.*")]

# Cartas de calibración de cianotipia elegibles en la interfaz.
CYANO_TARGET_LABELS = [
    "Tira Kamiru (21 parches)",
    "Carta EDN 2.2 (256 tonos)",
    "EDN ColorBlocker 3 (elegir color de tinta)",
]
NO_COLOR_PROFILE = "(color simple, sin degradado)"


def _target_key(label: str) -> str:
    l = (label or "").lower()
    if "colorblocker" in l:
        return "colorblocker"
    if "edn" in l:
        return "edn256"
    return "kamiru21"


# ════════════════════════════════════════════════════════════════
# FASE 2 · PROCESAR ESCANEOS
# ════════════════════════════════════════════════════════════════

class ScansPhase(PhaseFrame):
    """De los escaneos pintados/expuestos a los fotogramas digitales."""

    def __init__(self, master, app):
        super().__init__(master, app)
        self._last_report = None
        self._build_vars()
        self._build_ui()

    def _build_vars(self):
        self.var_scans_dir = tk.StringVar()
        self.var_layout = tk.StringVar()
        self.var_out_dir = tk.StringVar()
        self.var_bleed = tk.DoubleVar(value=1.5)         # en %
        self.var_min_markers = tk.IntVar(value=3)
        self.var_threads = tk.IntVar(value=max(2, min(6, (os.cpu_count() or 4) // 3)))
        self.var_mode = tk.StringVar(value="Automático (según el layout)")
        self.var_resize_orig = tk.BooleanVar(value=False)
        self.var_normalize = tk.BooleanVar(value=False)
        self.var_report = tk.BooleanVar(value=True)

    def _build_ui(self):
        sec = self.section(self, "Archivos")
        self._row_dir(sec, 0, "Carpeta con los escaneos:", self.var_scans_dir,
                      "Selecciona la carpeta con los escaneos")
        self._row_file(sec, 1, "Archivo layout (.json):", self.var_layout,
                       [("Layout JSON", "*.json"), ("Todos", "*.*")])
        self._row_dir(sec, 2, "Carpeta de salida:", self.var_out_dir,
                      "Selecciona dónde guardar los fotogramas recuperados")

        sec = self.section(self, "Opciones de procesamiento")
        ttk.Label(sec, text="Bleed / sangrado (%):").grid(row=0, column=0, sticky="w")
        bl = ttk.Frame(sec)
        bl.grid(row=0, column=1, sticky="w")
        ttk.Spinbox(bl, from_=0.0, to=5.0, increment=0.1, width=6,
                    textvariable=self.var_bleed).pack(side="left", padx=4)
        ttk.Label(bl, text="cuánto se recorta hacia dentro para evitar bordes "
                           "de papel", style="Sub.TLabel").pack(side="left")

        ttk.Label(sec, text="Marcadores mínimos:").grid(row=1, column=0,
                                                        sticky="w", pady=(6, 0))
        mm = ttk.Frame(sec)
        mm.grid(row=1, column=1, sticky="w", pady=(6, 0))
        ttk.Spinbox(mm, from_=2, to=12, width=6,
                    textvariable=self.var_min_markers).pack(side="left", padx=4)
        ttk.Label(mm, text="con 8-12 en la hoja, 3 detectados bastan",
                  style="Sub.TLabel").pack(side="left")

        ttk.Label(sec, text="Escaneos en paralelo:").grid(row=2, column=0,
                                                          sticky="w", pady=(6, 0))
        tt = ttk.Frame(sec)
        tt.grid(row=2, column=1, sticky="w", pady=(6, 0))
        ttk.Spinbox(tt, from_=1, to=12, width=6,
                    textvariable=self.var_threads).pack(side="left", padx=4)
        ttk.Label(tt, text="sube el valor en máquinas potentes (cada escaneo "
                           "grande usa 2-3 GB de RAM)",
                  style="Sub.TLabel").pack(side="left")

        ttk.Label(sec, text="Tipo de hoja escaneada:").grid(row=3, column=0,
                                                            sticky="w", pady=(6, 0))
        ttk.Combobox(sec, state="readonly", width=34, textvariable=self.var_mode,
                     values=["Automático (según el layout)",
                             "Normal (papel pintado)",
                             "Cianotipia (copia azul)"]).grid(
            row=3, column=1, sticky="w", padx=4, pady=(6, 0))

        ttk.Checkbutton(sec, text="Reescalar cada fotograma a su tamaño digital "
                                  "original (p. ej. 4K)",
                        variable=self.var_resize_orig).grid(
            row=4, column=0, columnspan=2, sticky="w", pady=(6, 0))
        ttk.Checkbutton(sec, text="Normalizar niveles con la tira de parches de "
                                  "grises (si la hoja la tiene)",
                        variable=self.var_normalize).grid(
            row=5, column=0, columnspan=2, sticky="w", pady=(2, 0))
        ttk.Checkbutton(sec, text="Generar informe (HTML con miniaturas + JSON + CSV)",
                        variable=self.var_report).grid(
            row=6, column=0, columnspan=2, sticky="w", pady=(2, 0))

        # Barra de acción
        bar = ttk.Frame(self, padding=(PAD, PAD, PAD, 0))
        bar.pack(fill="x")
        self.progress = ttk.Progressbar(bar, mode="determinate")
        self.progress.pack(fill="x")
        self.status_lbl = ttk.Label(bar, text="Listo.", style="Sub.TLabel")
        self.status_lbl.pack(anchor="w", pady=(2, 6))
        btns = ttk.Frame(bar)
        btns.pack(fill="x")
        self.run_btn = ttk.Button(btns, text="Procesar escaneos",
                                  style="Accent.TButton", command=self._on_run)
        self.run_btn.pack(side="right")
        self.cancel_btn = ttk.Button(btns, text="Cancelar", command=self.cancel,
                                     state="disabled")
        self.cancel_btn.pack(side="right", padx=(0, PAD))
        self.rescue_btn = ttk.Button(btns, text="🛟 Generar hojas de rescate",
                                     command=self._on_rescue, state="disabled")
        self.rescue_btn.pack(side="left")
        self.report_btn = ttk.Button(btns, text="Abrir informe",
                                     command=self._open_report, state="disabled")
        self.report_btn.pack(side="left", padx=(PAD, 0))

        self.build_log(self)
        self._append_log("Aquí se procesan los escaneos de las hojas pintadas "
                         "(o de las cianotipias). Necesitas el layout .json "
                         "que se creó junto a las hojas.")

    # ------------------------------------------------------------ widgets
    def _row_dir(self, sec, row, label, var, title):
        ttk.Label(sec, text=label).grid(row=row, column=0, sticky="w", pady=(4, 0))
        ttk.Entry(sec, textvariable=var).grid(row=row, column=1, sticky="ew",
                                              padx=4, pady=(4, 0))
        ttk.Button(sec, text="Examinar…",
                   command=lambda: self._pick_dir(var, title)).grid(
            row=row, column=2, pady=(4, 0))

    def _row_file(self, sec, row, label, var, types):
        ttk.Label(sec, text=label).grid(row=row, column=0, sticky="w", pady=(4, 0))
        ttk.Entry(sec, textvariable=var).grid(row=row, column=1, sticky="ew",
                                              padx=4, pady=(4, 0))
        ttk.Button(sec, text="Examinar…",
                   command=lambda: self._pick_file(var, types)).grid(
            row=row, column=2, pady=(4, 0))

    def _pick_dir(self, var, title):
        d = filedialog.askdirectory(title=title)
        if d:
            var.set(d)

    def _pick_file(self, var, types):
        f = filedialog.askopenfilename(title="Elegir archivo", filetypes=types)
        if f:
            var.set(f)

    # ------------------------------------------------------------ ejecutar
    def _opts(self) -> scan.ScanOptions:
        modo = self.var_mode.get().lower()
        if modo.startswith("normal"):
            mode = "normal"
        elif modo.startswith("cian"):
            mode = "cianotipia"
        else:
            mode = "auto"
        return scan.ScanOptions(
            bleed=self.to_float(self.var_bleed, 1.5) / 100.0,
            min_markers=self.to_int(self.var_min_markers, 3),
            threads=self.to_int(self.var_threads, 3),
            mode=mode,
            resize_to_original=self.var_resize_orig.get(),
            normalize_patches=self.var_normalize.get(),
            report=self.var_report.get(),
        )

    def _on_run(self):
        sdir, layout, odir = (self.var_scans_dir.get().strip(),
                              self.var_layout.get().strip(),
                              self.var_out_dir.get().strip())
        if not sdir or not Path(sdir).is_dir():
            messagebox.showwarning("Falta algo", "Elige la carpeta con los escaneos.")
            return
        if not layout or not Path(layout).is_file():
            messagebox.showwarning("Falta algo", "Elige el archivo layout (.json) "
                                                 "que se generó con las hojas.")
            return
        if not odir:
            messagebox.showwarning("Falta algo", "Elige la carpeta de salida.")
            return
        self._set_busy(True)
        self._last_report = None
        self.rescue_btn.configure(state="disabled")
        self.report_btn.configure(state="disabled")
        self.progress.configure(value=0, maximum=100)
        self.status_lbl.configure(text="Procesando…")
        self.log("═" * 30)
        opts = self._opts()
        self.start_worker(self._work, sdir, layout, odir, opts)

    def _work(self, sdir, layout, odir, opts):
        try:
            rep = scan.procesar_carpeta(
                sdir, layout, odir, opts,
                progress_cb=lambda d, t: self.queue.put(("progress", d, t)),
                cancel_check=self.cancelled,
                log=self.log)
            self.queue.put(("done", rep))
        except scan._Cancelled:
            self.queue.put(("cancelled", None))
        except Exception as e:
            self.queue.put(("error", str(e)))

    def handle(self, msg):
        kind = msg[0]
        if kind == "progress":
            done, total = msg[1], msg[2]
            self.progress.configure(maximum=max(1, total), value=done)
            self.status_lbl.configure(text=f"Procesando escaneos…  {done}/{total}")
        elif kind == "done":
            rep = msg[1]
            self._last_report = rep
            self._set_busy(False)
            ok, tot = rep["escaneos_ok"], rep["escaneos_procesados"]
            fx, fe = rep["frames_extraidos"], rep["frames_esperados"]
            falt = rep["etiquetas_faltantes"]
            self.status_lbl.configure(
                text=f"¡Listo! {ok}/{tot} escaneos correctos · "
                     f"{fx}/{fe} fotogramas recuperados.")
            self.log(f"✅ {fx}/{fe} fotogramas recuperados "
                     f"({ok}/{tot} escaneos correctos).")
            if falt:
                self.log(f"⚠️ Faltan {len(falt)} fotograma(s): "
                         + ", ".join(falt[:12])
                         + ("…" if len(falt) > 12 else ""))
                self.rescue_btn.configure(state="normal")
            self.report_btn.configure(state="normal")
            # Avisar a la fase de video para autocompletar rutas.
            try:
                self.app.video_phase.suggest(self.var_layout.get(),
                                             self.var_out_dir.get())
            except Exception:
                pass
            if messagebox.askyesno("Procesamiento completado",
                                   f"Se recuperaron {fx} de {fe} fotogramas.\n"
                                   "¿Abrir la carpeta de salida?"):
                self.open_folder(self.var_out_dir.get())
        elif kind == "cancelled":
            self._set_busy(False)
            self.status_lbl.configure(text="Cancelado.")
        elif kind == "error":
            self._set_busy(False)
            self.status_lbl.configure(text="Error.")
            messagebox.showerror("Ups, algo falló", msg[1])
        elif kind == "rescue_done":
            self._set_busy(False)
            res = msg[1]
            self.log(f"🛟 Hojas de rescate generadas: {res['num_generated']} "
                     f"hoja(s). Layout: {res.get('layout')}")
            if messagebox.askyesno(
                    "Hojas de rescate listas",
                    f"Se generaron {res['num_generated']} hoja(s) de rescate.\n"
                    "Imprímelas, píntalas/exponlas, escanéalas y procésalas "
                    "usando el layout de rescate.\n\n¿Abrir la carpeta?"):
                if res.get("layout"):
                    self.open_folder(str(Path(res["layout"]).parent))

    def _set_busy(self, busy):
        self.run_btn.configure(state="disabled" if busy else "normal")
        self.cancel_btn.configure(state="normal" if busy else "disabled")

    # ------------------------------------------------------------ extras
    def _open_report(self):
        out = self.var_out_dir.get().strip()
        report = Path(out) / "informe.html"
        if report.is_file():
            self.open_folder(report)
        else:
            messagebox.showinfo("Informe", "Todavía no hay informe en la "
                                           "carpeta de salida.")

    def _on_rescue(self):
        layout = self.var_layout.get().strip()
        faltantes = None
        if self._last_report:
            faltantes = self._last_report.get("etiquetas_faltantes")
        if not faltantes:
            # Intentar leer el informe.json de la carpeta de salida.
            try:
                with open(Path(self.var_out_dir.get()) / "informe.json",
                          "r", encoding="utf-8") as f:
                    faltantes = json.load(f).get("etiquetas_faltantes")
            except Exception:
                faltantes = None
        if not faltantes:
            messagebox.showinfo("Hojas de rescate",
                                "No hay fotogramas faltantes registrados. "
                                "Procesa primero los escaneos.")
            return
        self._set_busy(True)
        self.status_lbl.configure(text="Generando hojas de rescate…")
        self.start_worker(self._work_rescue, layout, list(faltantes))

    def _work_rescue(self, layout, faltantes):
        try:
            res = rescue.generar_hojas_rescate(layout, faltantes, log=self.log)
            self.queue.put(("rescue_done", res))
        except Exception as e:
            self.queue.put(("error", str(e)))

    # Llamado por la fase 1 al terminar de generar hojas.
    def suggest(self, layout_path: str):
        if layout_path:
            self.var_layout.set(layout_path)


# ════════════════════════════════════════════════════════════════
# FASE 3 · CALIBRACIÓN
# ════════════════════════════════════════════════════════════════

class CalibPhase(PhaseFrame):
    """Calibración de impresora y del proceso de cianotipia."""

    def __init__(self, master, app):
        super().__init__(master, app)
        self._printer_profile = None
        self._cyano_profile = None
        self._build_vars()
        self._build_ui()

    def _build_vars(self):
        self.var_p_paper = tk.StringVar(value="A4")
        self.var_p_dpi = tk.IntVar(value=300)
        self.var_p_scan = tk.StringVar()
        self.var_p_scan_dpi = tk.StringVar(value="")
        self.var_p_name = tk.StringVar(value="Mi impresora")
        self.var_c_paper = tk.StringVar(value="A4")
        self.var_c_dpi = tk.IntVar(value=300)
        self.var_c_ink = tk.StringVar(value="#000000")
        self.var_c_mirror = tk.BooleanVar(value=True)
        self.var_c_scan = tk.StringVar()
        self.var_c_name = tk.StringVar(value="Mi cianotipia")
        self.var_c_target = tk.StringVar(value=CYANO_TARGET_LABELS[0])
        self.var_c_colorprofile = tk.StringVar(value=NO_COLOR_PROFILE)

    def _build_ui(self):
        cols = ttk.Frame(self)
        cols.pack(fill="both", expand=True)
        left = ttk.Frame(cols)
        left.pack(side="left", fill="both", expand=True)
        right = ttk.Frame(cols)
        right.pack(side="left", fill="both", expand=True)

        # ── Impresora ────────────────────────────────────────────
        sec = self.section(left, "🖨  Impresora")
        ttk.Label(sec, text="1. Genera la página de prueba, imprímela al 100 % "
                            "(sin «ajustar a página») y escanéala completa.",
                  style="Sub.TLabel", wraplength=380).grid(
            row=0, column=0, columnspan=3, sticky="w")
        ttk.Label(sec, text="Papel:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        pp = ttk.Frame(sec)
        pp.grid(row=1, column=1, columnspan=2, sticky="w", pady=(6, 0))
        ttk.Combobox(pp, values=[p for p in paper.PAPER_ORDER if p != "Personalizado"],
                     textvariable=self.var_p_paper, state="readonly",
                     width=16).pack(side="left", padx=4)
        ttk.Label(pp, text="DPI:").pack(side="left", padx=(8, 0))
        ttk.Spinbox(pp, from_=150, to=1200, increment=50, width=6,
                    textvariable=self.var_p_dpi).pack(side="left", padx=4)
        ttk.Button(sec, text="Generar página de prueba…",
                   command=self._gen_printer_page).grid(
            row=2, column=0, columnspan=3, sticky="w", pady=(8, 4))

        ttk.Label(sec, text="2. Analiza el escaneo de la página impresa:",
                  style="Sub.TLabel").grid(row=3, column=0, columnspan=3, sticky="w")
        ttk.Entry(sec, textvariable=self.var_p_scan).grid(
            row=4, column=0, columnspan=2, sticky="ew", padx=(0, 4), pady=(4, 0))
        ttk.Button(sec, text="Examinar…",
                   command=lambda: self._pick(self.var_p_scan)).grid(
            row=4, column=2, pady=(4, 0))
        dd = ttk.Frame(sec)
        dd.grid(row=5, column=0, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Label(dd, text="DPI del escaneo (vacío = leer del archivo):").pack(side="left")
        ttk.Entry(dd, textvariable=self.var_p_scan_dpi, width=8).pack(side="left", padx=4)
        ttk.Button(sec, text="Analizar escaneo", command=self._analyze_printer).grid(
            row=6, column=0, columnspan=3, sticky="w", pady=(8, 4))

        nn = ttk.Frame(sec)
        nn.grid(row=7, column=0, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Label(nn, text="Nombre del perfil:").pack(side="left")
        ttk.Entry(nn, textvariable=self.var_p_name, width=18).pack(side="left", padx=4)
        self.p_save_btn = ttk.Button(nn, text="Guardar perfil", state="disabled",
                                     command=self._save_printer)
        self.p_save_btn.pack(side="left", padx=4)

        # ── Cianotipia ───────────────────────────────────────────
        sec = self.section(right, "☀️  Cianotipia")
        ttk.Label(sec, text="1. Elige la carta, genérala, imprímela en ACETATO "
                            "(mismo color de tinta y espejado que usarás), expón "
                            "tu cianotipia como siempre, revela, seca y escanea "
                            "el resultado azul.",
                  style="Sub.TLabel", wraplength=380).grid(
            row=0, column=0, columnspan=3, sticky="w")

        tg = ttk.Frame(sec)
        tg.grid(row=1, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(tg, text="Carta:").pack(side="left")
        ttk.Combobox(tg, values=CYANO_TARGET_LABELS,
                     textvariable=self.var_c_target, state="readonly",
                     width=34).pack(side="left", padx=4)
        ttk.Label(sec, text="EDN 2.2 = curva fina con 256 tonos · ColorBlocker "
                            "= descubre QUÉ COLOR de tinta bloquea mejor el UV "
                            "en tu impresora (método easydigitalnegatives.com).",
                  style="Sub.TLabel", wraplength=380).grid(
            row=2, column=0, columnspan=3, sticky="w", pady=(2, 0))

        cc = ttk.Frame(sec)
        cc.grid(row=3, column=0, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(cc, text="Papel:").pack(side="left")
        ttk.Combobox(cc, values=[p for p in paper.PAPER_ORDER if p != "Personalizado"],
                     textvariable=self.var_c_paper, state="readonly",
                     width=14).pack(side="left", padx=4)
        ttk.Label(cc, text="DPI:").pack(side="left", padx=(8, 0))
        ttk.Spinbox(cc, from_=150, to=1200, increment=50, width=6,
                    textvariable=self.var_c_dpi).pack(side="left", padx=4)
        ik = ttk.Frame(sec)
        ik.grid(row=4, column=0, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Label(ik, text="Color de tinta del negativo:").grid(row=0, column=0)
        self.color_picker(ik, self.var_c_ink, row=0, col=1)
        cp = ttk.Frame(sec)
        cp.grid(row=5, column=0, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Label(cp, text="Perfil de color (ColorBlocker):").pack(side="left")
        self.c_colorprofile_cb = ttk.Combobox(
            cp, textvariable=self.var_c_colorprofile, state="readonly",
            width=24, values=[NO_COLOR_PROFILE])
        self.c_colorprofile_cb.pack(side="left", padx=4)
        ttk.Checkbutton(sec, text="Espejar (imprimir en espejo, recomendado)",
                        variable=self.var_c_mirror).grid(
            row=6, column=0, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Button(sec, text="Generar carta de calibración…",
                   command=self._gen_cyano_strip).grid(
            row=7, column=0, columnspan=3, sticky="w", pady=(8, 4))

        ttk.Label(sec, text="2. Analiza el escaneo de la CIANOTIPIA (no del acetato):",
                  style="Sub.TLabel", wraplength=380).grid(
            row=8, column=0, columnspan=3, sticky="w")
        ttk.Entry(sec, textvariable=self.var_c_scan).grid(
            row=9, column=0, columnspan=2, sticky="ew", padx=(0, 4), pady=(4, 0))
        ttk.Button(sec, text="Examinar…",
                   command=lambda: self._pick(self.var_c_scan)).grid(
            row=9, column=2, pady=(4, 0))
        ttk.Button(sec, text="Analizar cianotipia", command=self._analyze_cyano).grid(
            row=10, column=0, columnspan=3, sticky="w", pady=(8, 4))

        nn = ttk.Frame(sec)
        nn.grid(row=11, column=0, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Label(nn, text="Nombre del perfil:").pack(side="left")
        ttk.Entry(nn, textvariable=self.var_c_name, width=18).pack(side="left", padx=4)
        self.c_save_btn = ttk.Button(nn, text="Guardar perfil", state="disabled",
                                     command=self._save_cyano)
        self.c_save_btn.pack(side="left", padx=4)
        self.refresh_color_profiles()

        self.build_log(self, height=10)
        self._append_log(
            "Los perfiles guardados aquí aparecen en la fase «① Generar hojas» "
            "(perfil de impresora en la pestaña Hoja; curva de cianotipia en la "
            "pestaña Cianotipia).")

    def _pick(self, var):
        f = filedialog.askopenfilename(title="Elegir escaneo", filetypes=_IMG_TYPES)
        if f:
            var.set(f)

    # ---------------------------------------------------------- impresora
    def _gen_printer_page(self):
        path = filedialog.asksaveasfilename(
            title="Guardar página de prueba",
            defaultextension=".tif",
            initialfile="prueba_impresora.tif",
            filetypes=[("TIFF", "*.tif"), ("PNG", "*.png")])
        if not path:
            return
        try:
            out = calibration.generar_pagina_prueba_impresora(
                path, self.var_p_paper.get(), self.to_int(self.var_p_dpi, 300))
            self.log(f"✅ Página de prueba guardada: {out}")
            self.log("   Imprímela al 100 % (sin «ajustar a página») y "
                     "escanéala completa, plana y derecha.")
        except Exception as e:
            messagebox.showerror("Ups", str(e))

    def _analyze_printer(self):
        scan_path = self.var_p_scan.get().strip()
        if not scan_path or not Path(scan_path).is_file():
            messagebox.showwarning("Falta algo", "Elige el escaneo de la página "
                                                 "de prueba impresa.")
            return
        try:
            scan_dpi = float(self.var_p_scan_dpi.get()) if self.var_p_scan_dpi.get().strip() else None
        except ValueError:
            scan_dpi = None
        self.log("═" * 30)
        self.log("Analizando página de prueba…")
        self.start_worker(self._work_printer, scan_path,
                          self.var_p_paper.get(),
                          self.to_int(self.var_p_dpi, 300), scan_dpi)

    def _work_printer(self, scan_path, paper_name, dpi, scan_dpi):
        try:
            prof = calibration.analizar_prueba_impresora(
                scan_path, paper_name, dpi, scan_dpi, log=self.log)
            self.queue.put(("printer_done", prof))
        except Exception as e:
            self.queue.put(("error", str(e)))

    # ---------------------------------------------------------- cianotipia
    def refresh_color_profiles(self):
        values = [NO_COLOR_PROFILE] + config.list_profiles("cianotipia_color")
        self.c_colorprofile_cb.configure(values=values)
        if self.var_c_colorprofile.get() not in values:
            self.var_c_colorprofile.set(NO_COLOR_PROFILE)

    def _color_stops(self):
        """Stops del perfil de color elegido (o None para color simple)."""
        name = self.var_c_colorprofile.get()
        if not name or name == NO_COLOR_PROFILE:
            return None
        prof = config.load_profile("cianotipia_color", name)
        return prof.get("stops") if prof else None

    def _gen_cyano_strip(self):
        target = _target_key(self.var_c_target.get())
        nombre = {"colorblocker": "colorblocker",
                  "edn256": "carta_edn256",
                  "kamiru21": "tira_cianotipia"}[target]
        path = filedialog.asksaveasfilename(
            title="Guardar carta de calibración",
            defaultextension=".tif",
            initialfile=f"{nombre}.tif",
            filetypes=[("TIFF", "*.tif"), ("PNG", "*.png")])
        if not path:
            return
        try:
            if target == "colorblocker":
                out = calibration.generar_colorblocker(
                    path, self.var_c_paper.get(),
                    self.to_int(self.var_c_dpi, 300),
                    self.var_c_mirror.get())
            else:
                out = calibration.generar_tira_cianotipia(
                    path, self.var_c_paper.get(),
                    self.to_int(self.var_c_dpi, 300),
                    self.var_c_ink.get(), self.var_c_mirror.get(),
                    target=target, ink_stops=self._color_stops())
            self.log(f"✅ Carta de calibración guardada: {out}")
            self.log("   Imprímela en acetato, haz tu cianotipia como siempre "
                     "y escanea el resultado azul seco.")
        except Exception as e:
            messagebox.showerror("Ups", str(e))

    def _analyze_cyano(self):
        scan_path = self.var_c_scan.get().strip()
        if not scan_path or not Path(scan_path).is_file():
            messagebox.showwarning("Falta algo", "Elige el escaneo de la "
                                                 "cianotipia de la carta.")
            return
        self.log("═" * 30)
        self.log("Analizando cianotipia…")
        self.start_worker(self._work_cyano, scan_path,
                          self.var_c_paper.get(), self.to_int(self.var_c_dpi, 300),
                          _target_key(self.var_c_target.get()))

    def _work_cyano(self, scan_path, paper_name, dpi, target):
        try:
            if target == "colorblocker":
                prof = calibration.analizar_colorblocker(
                    scan_path, paper_name, dpi, log=self.log)
                self.queue.put(("cb_done", prof))
            else:
                prof = calibration.analizar_tira_cianotipia(
                    scan_path, paper_name, dpi, target=target, log=self.log)
                self.queue.put(("cyano_done", prof))
        except Exception as e:
            self.queue.put(("error", str(e)))

    # ---------------------------------------------------------- mensajes
    def handle(self, msg):
        kind = msg[0]
        if kind == "printer_done":
            self._printer_profile = msg[1]
            p = msg[1]
            self.log(f"📋 Resultado: escala {p['scale_x'] * 100:.2f} % × "
                     f"{p['scale_y'] * 100:.2f} % · marcador recomendado "
                     f"{p['marker_recomendado_mm']:g} mm · QR recomendado "
                     f"{p['qr_recomendado_mm']:g} mm")
            for n in p.get("notas", []):
                self.log(f"   • {n}")
            self.p_save_btn.configure(state="normal")
        elif kind == "cyano_done":
            self._cyano_profile = msg[1]
            p = msg[1]
            self.log(f"📋 Rango dinámico: {p['rango_dinamico'] * 100:.0f} % · "
                     f"curva de {len(p['lut'])} valores construida "
                     f"({p.get('steps', '?')} parches medidos).")
            for n in p.get("notas", []):
                self.log(f"   • {n}")
            self.c_save_btn.configure(state="normal")
        elif kind == "cb_done":
            self._cyano_profile = msg[1]
            p = msg[1]
            self.log(f"📋 Mejor color bloqueador: {p['mejor_color']} · "
                     f"degradado: " + " → ".join(c for _, c in p["stops"]))
            for n in p.get("notas", []):
                self.log(f"   • {n}")
            self.var_c_ink.set(p["mejor_color"])
            self.c_save_btn.configure(state="normal")
        elif kind == "error":
            messagebox.showerror("Ups, algo falló", msg[1])

    def _save_printer(self):
        if not self._printer_profile:
            return
        name = self.var_p_name.get().strip() or "Mi impresora"
        path = config.save_profile("impresora", name, self._printer_profile)
        self.log(f"💾 Perfil de impresora «{name}» guardado ({path}).")
        try:
            self.app.sheets_phase.refresh_profiles()
        except Exception:
            pass

    def _save_cyano(self):
        if not self._cyano_profile:
            return
        name = self.var_c_name.get().strip() or "Mi cianotipia"
        kind = ("cianotipia_color"
                if self._cyano_profile.get("tipo") == "cianotipia_color"
                else "cianotipia")
        path = config.save_profile(kind, name, self._cyano_profile)
        etiqueta = "de color (ColorBlocker)" if kind == "cianotipia_color" else "de curva"
        self.log(f"💾 Perfil {etiqueta} «{name}» guardado ({path}).")
        self.refresh_color_profiles()
        try:
            self.app.sheets_phase.refresh_profiles()
        except Exception:
            pass


# ════════════════════════════════════════════════════════════════
# FASE 4 · VIDEO FINAL
# ════════════════════════════════════════════════════════════════

class VideoPhase(PhaseFrame):
    """Reconstruye el video final desde los fotogramas procesados."""

    def __init__(self, master, app):
        super().__init__(master, app)
        self._build_vars()
        self._build_ui()

    def _build_vars(self):
        self.var_layout = tk.StringVar()
        self.var_frames_dir = tk.StringVar()
        self.var_fps = tk.DoubleVar(value=12.0)
        self.var_codec = tk.StringVar(value=videoout.CODECS[0])
        self.var_out = tk.StringVar()

    def _build_ui(self):
        sec = self.section(self, "Origen")
        ttk.Label(sec, text="Layout (.json) del proyecto:").grid(row=0, column=0, sticky="w")
        ttk.Entry(sec, textvariable=self.var_layout).grid(row=0, column=1,
                                                          sticky="ew", padx=4)
        ttk.Button(sec, text="Examinar…", command=self._pick_layout).grid(row=0, column=2)
        ttk.Label(sec, text="Carpeta con los fotogramas procesados:").grid(
            row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_frames_dir).grid(
            row=1, column=1, sticky="ew", padx=4, pady=(6, 0))
        ttk.Button(sec, text="Examinar…", command=self._pick_frames).grid(
            row=1, column=2, pady=(6, 0))
        ttk.Label(sec, text="Con la línea de tiempo del layout, los fotogramas "
                            "deduplicados se repiten automáticamente en sus "
                            "posiciones originales.", style="Sub.TLabel",
                  wraplength=760).grid(row=2, column=0, columnspan=3,
                                       sticky="w", pady=(6, 0))

        sec = self.section(self, "Video")
        ff = ttk.Frame(sec)
        ff.grid(row=0, column=0, columnspan=3, sticky="w")
        ttk.Label(ff, text="Fotogramas por segundo (fps):").pack(side="left")
        ttk.Spinbox(ff, from_=0.1, to=120, increment=0.5, width=8,
                    textvariable=self.var_fps).pack(side="left", padx=4)
        ttk.Label(ff, text="Códec:").pack(side="left", padx=(PAD, 0))
        ttk.Combobox(ff, values=videoout.CODECS, textvariable=self.var_codec,
                     state="readonly", width=34).pack(side="left", padx=4)
        ttk.Label(sec, text="Archivo de salida:").grid(row=1, column=0,
                                                       sticky="w", pady=(6, 0))
        ttk.Entry(sec, textvariable=self.var_out).grid(row=1, column=1,
                                                       sticky="ew", padx=4,
                                                       pady=(6, 0))
        ttk.Button(sec, text="Examinar…", command=self._pick_out).grid(
            row=1, column=2, pady=(6, 0))

        bar = ttk.Frame(self, padding=(PAD, PAD, PAD, 0))
        bar.pack(fill="x")
        self.progress = ttk.Progressbar(bar, mode="determinate")
        self.progress.pack(fill="x")
        self.status_lbl = ttk.Label(bar, text="Listo.", style="Sub.TLabel")
        self.status_lbl.pack(anchor="w", pady=(2, 6))
        btns = ttk.Frame(bar)
        btns.pack(fill="x")
        self.run_btn = ttk.Button(btns, text="Crear video",
                                  style="Accent.TButton", command=self._on_run)
        self.run_btn.pack(side="right")
        self.cancel_btn = ttk.Button(btns, text="Cancelar", command=self.cancel,
                                     state="disabled")
        self.cancel_btn.pack(side="right", padx=(0, PAD))

        self.build_log(self)
        self._append_log("El último paso: convierte los fotogramas recuperados "
                         "de nuevo en video, en el orden original.")

    def _pick_layout(self):
        f = filedialog.askopenfilename(title="Elegir layout",
                                       filetypes=[("Layout JSON", "*.json"),
                                                  ("Todos", "*.*")])
        if f:
            self.var_layout.set(f)
            self._fps_from_layout(f)

    def _fps_from_layout(self, path):
        try:
            layout = layoutfile.load(path)
            fps = layout.get("video", {}).get("fps_extraccion")
            if fps:
                self.var_fps.set(float(fps))
        except Exception:
            pass

    def _pick_frames(self):
        d = filedialog.askdirectory(title="Carpeta con los fotogramas procesados")
        if d:
            self.var_frames_dir.set(d)

    def _pick_out(self):
        f = filedialog.asksaveasfilename(title="Guardar video",
                                         defaultextension=".mp4",
                                         initialfile="video_final.mp4",
                                         filetypes=[("MP4", "*.mp4"),
                                                    ("MOV", "*.mov")])
        if f:
            self.var_out.set(f)

    def suggest(self, layout_path: str, frames_dir: str):
        """Autocompletado desde la fase de escaneos."""
        if layout_path and not self.var_layout.get():
            self.var_layout.set(layout_path)
            self._fps_from_layout(layout_path)
        if frames_dir and not self.var_frames_dir.get():
            self.var_frames_dir.set(frames_dir)
            if not self.var_out.get():
                self.var_out.set(str(Path(frames_dir) / "video_final.mp4"))

    def _on_run(self):
        layout_p = self.var_layout.get().strip()
        frames_d = self.var_frames_dir.get().strip()
        out = self.var_out.get().strip()
        if not layout_p or not Path(layout_p).is_file():
            messagebox.showwarning("Falta algo", "Elige el layout (.json) del proyecto.")
            return
        if not frames_d or not Path(frames_d).is_dir():
            messagebox.showwarning("Falta algo", "Elige la carpeta con los "
                                                 "fotogramas procesados.")
            return
        if not out:
            messagebox.showwarning("Falta algo", "Elige el archivo de salida.")
            return
        fps = self.to_float(self.var_fps, 12.0)
        if fps <= 0:
            messagebox.showwarning("Falta algo", "El fps debe ser mayor que 0.")
            return
        self.run_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.progress.configure(value=0, maximum=100)
        self.status_lbl.configure(text="Preparando…")
        self.log("═" * 30)
        self.start_worker(self._work, layout_p, frames_d, out, fps,
                          self.var_codec.get())

    def _work(self, layout_p, frames_d, out, fps, codec):
        try:
            layout = layoutfile.load(layout_p)
            files, missing = videoout.frames_from_timeline(layout, frames_d)
            if missing:
                self.log(f"⚠️ Faltan {len(missing)} fotograma(s) procesado(s): "
                         + ", ".join(missing[:10])
                         + ("…" if len(missing) > 10 else ""))
                self.log("   El video se armará con los disponibles (las "
                         "posiciones faltantes se saltan).")
            if not files:
                raise ValueError(
                    "No se encontró ningún fotograma procesado que coincida "
                    "con el layout. Revisa la carpeta.")
            self.log(f"Armando video con {len(files)} fotogramas a {fps:g} fps…")
            path = videoout.build_video(
                files, fps, out, codec,
                progress_cb=lambda d, t: self.queue.put(("progress", d, t)),
                cancel_check=self.cancelled)
            self.queue.put(("done", path))
        except videoout._Cancelled:
            self.queue.put(("cancelled", None))
        except Exception as e:
            self.queue.put(("error", str(e)))

    def handle(self, msg):
        kind = msg[0]
        if kind == "progress":
            done, total = msg[1], msg[2]
            self.progress.configure(maximum=max(1, total), value=min(done, total))
            self.status_lbl.configure(text=f"Codificando…  {done}/{total}")
        elif kind == "done":
            self.run_btn.configure(state="normal")
            self.cancel_btn.configure(state="disabled")
            self.progress.configure(value=self.progress["maximum"])
            self.status_lbl.configure(text="¡Video creado!")
            self.log(f"🎬 Video creado: {msg[1]}")
            if messagebox.askyesno("¡Video creado! 🎬",
                                   f"Se guardó en:\n{msg[1]}\n\n¿Abrir la carpeta?"):
                self.open_folder(str(Path(msg[1]).parent))
        elif kind == "cancelled":
            self.run_btn.configure(state="normal")
            self.cancel_btn.configure(state="disabled")
            self.status_lbl.configure(text="Cancelado.")
        elif kind == "error":
            self.run_btn.configure(state="normal")
            self.cancel_btn.configure(state="disabled")
            self.status_lbl.configure(text="Error.")
            messagebox.showerror("Ups, algo falló", msg[1])
