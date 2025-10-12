import sys
from pathlib import Path

# Ensure backend package is importable when running on Vercel
project_root = Path(__file__).resolve().parents[1]
backend_path = project_root / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(project_root))
    sys.path.insert(0, str(backend_path))

from backend.main import app  # noqa: E402


# Vercel looks for a module-level variable named `app`
# FastAPI app is imported from backend.main
__all__ = ["app"]
