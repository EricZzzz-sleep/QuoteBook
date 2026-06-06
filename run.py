#!/usr/bin/env python3
"""Set up and run QuoteBook locally."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
VENV = ROOT / ".venv"
REQUIREMENTS = BACKEND / "requirements.txt"
DEFAULT_PORT = "8000"


def venv_python() -> Path:
    if os.name == "nt":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def run(command: list[str | Path], cwd: Path = ROOT) -> None:
    printable = " ".join(str(part) for part in command)
    print(f"\n> {printable}")
    subprocess.run([str(part) for part in command], cwd=cwd, check=True)


def ensure_python_version() -> None:
    if sys.version_info < (3, 10):
        version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        raise SystemExit(f"QuoteBook needs Python 3.10 or newer. This is Python {version}.")


def ensure_virtualenv() -> Path:
    python = venv_python()
    if python.exists():
        return python

    print("Creating a local Python virtual environment in .venv...")
    run([sys.executable, "-m", "venv", VENV])
    return python


def install_dependencies(python: Path) -> None:
    run([python, "-m", "pip", "install", "--upgrade", "pip"])
    run([python, "-m", "pip", "install", "-r", REQUIREMENTS])


def migrate_database(python: Path) -> None:
    run([python, "manage.py", "migrate"], cwd=BACKEND)


def run_server(python: Path) -> None:
    port = os.environ.get("PORT", DEFAULT_PORT)
    host = os.environ.get("HOST", "127.0.0.1")
    url_host = "localhost" if host in {"127.0.0.1", "0.0.0.0"} else host
    print(f"\nQuoteBook is starting at http://{url_host}:{port}")
    print("Press Ctrl+C to stop the server.\n")
    run([python, "manage.py", "runserver", f"{host}:{port}"], cwd=BACKEND)


def main() -> None:
    ensure_python_version()
    python = ensure_virtualenv()
    install_dependencies(python)
    if "--install-only" in sys.argv:
        print("\nDependencies are installed in .venv.")
        return
    migrate_database(python)
    run_server(python)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from error
