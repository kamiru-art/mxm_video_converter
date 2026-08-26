"""Carga y guardado de la configuración del usuario (para recordar ajustes),
presets con nombre y perfiles de calibración (impresora / cianotipia)."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


def _config_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA", Path.home()))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    d = base / "Kamiru"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        d = Path.home()
    return d


CONFIG_PATH = _config_dir() / "settings.json"

# Tipos de perfiles de calibración y de presets.
# "cianotipia" = curvas de compensación; "cianotipia_color" = perfiles de
# color de tinta (ColorBlocker).
PROFILE_KINDS = ("impresora", "cianotipia", "cianotipia_color")


def load() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return {}


def save(data: dict) -> None:
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError:
        pass


# ────────────────────────────────────────────────────────────────
# Perfiles de calibración y presets con nombre
# ────────────────────────────────────────────────────────────────

def _safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]+', "_", str(name)).strip()
    return name or "perfil"


def profiles_dir(kind: str) -> Path:
    d = _config_dir() / "perfiles" / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_profiles(kind: str) -> list[str]:
    """Nombres de los perfiles guardados de un tipo, ordenados."""
    try:
        return sorted(p.stem for p in profiles_dir(kind).glob("*.json"))
    except OSError:
        return []


def load_profile(kind: str, name: str) -> dict | None:
    path = profiles_dir(kind) / f"{_safe_name(name)}.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None


def save_profile(kind: str, name: str, data: dict) -> Path:
    path = profiles_dir(kind) / f"{_safe_name(name)}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return path


def delete_profile(kind: str, name: str) -> bool:
    path = profiles_dir(kind) / f"{_safe_name(name)}.json"
    try:
        path.unlink()
        return True
    except OSError:
        return False


# Presets: una foto completa de todos los ajustes de la interfaz, con nombre.

def presets_dir() -> Path:
    d = _config_dir() / "presets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_presets() -> list[str]:
    try:
        return sorted(p.stem for p in presets_dir().glob("*.json"))
    except OSError:
        return []


def load_preset(name: str) -> dict | None:
    path = presets_dir() / f"{_safe_name(name)}.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None


def save_preset(name: str, data: dict) -> Path:
    path = presets_dir() / f"{_safe_name(name)}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return path


def delete_preset(name: str) -> bool:
    path = presets_dir() / f"{_safe_name(name)}.json"
    try:
        path.unlink()
        return True
    except OSError:
        return False
