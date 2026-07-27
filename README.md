# PDF Analyzer

Flask web app that inspects PDF metadata to classify files as **Real PDF** (original) or **Fake PDF** (modified).

## Classification rules

| Verdict | Condition |
|---------|-----------|
| **Real PDF** | Metadata contains `skia` and does **not** contain `adobe` or `canva` |
| **Fake PDF** | Metadata contains `adobe` or `canva` |
| **Unknown** | Neither condition matched |

## Requirements

- [uv](https://docs.astral.sh/uv/) package manager
- Python 3.14+

## Setup & run

```bash
# Install dependencies
uv sync

# Start the dev server
uv run python app.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000) in your browser.

## Features

- Upload individual PDFs or entire folders
- Upload & analysis progress bars
- Multithreaded backend with per-file timeout protection
- Modern dark-mode UI
