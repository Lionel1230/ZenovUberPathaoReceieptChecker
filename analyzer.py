"""PDF metadata analyzer — detects real vs modified PDFs."""

from __future__ import annotations

import logging
from concurrent.futures import (
    ThreadPoolExecutor,
    TimeoutError as FuturesTimeoutError,
    as_completed,
)
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable

from pypdf import PdfReader
from pypdf.errors import PdfReadError

logger = logging.getLogger(__name__)

ANALYSIS_TIMEOUT_SECONDS = 30
MAX_WORKERS = 4

FAKE_KEYWORDS = ("adobe", "canva", "pdfleader", "pdf editor")
REAL_KEYWORD = "skia"


class PdfVerdict(str, Enum):
    REAL = "real"
    FAKE = "fake"
    UNKNOWN = "unknown"
    ERROR = "error"


@dataclass
class PdfAnalysisResult:
    filename: str
    verdict: PdfVerdict
    producer: str = ""
    creator: str = ""
    matched_keywords: list[str] = field(default_factory=list)
    error_message: str = ""


def _extract_xmp_text(reader: PdfReader) -> str:
    """Extract raw XMP XML from the PDF metadata stream."""
    try:
        xmp = reader.xmp_metadata
        if xmp is not None and hasattr(xmp, "stream"):
            return xmp.stream.get_data().decode("utf-8", errors="ignore")
    except (PdfReadError, AttributeError, OSError):
        pass
    return ""


def _extract_xmp_fallback(pdf_path: Path) -> str:
    """Fallback: locate XMP packet directly in the PDF bytes."""
    try:
        data = pdf_path.read_bytes()
    except OSError:
        return ""

    start = data.find(b"<?xpacket")
    if start != -1:
        end_marker = data.find(b"<?xpacket end", start)
        if end_marker != -1:
            close = data.find(b"?>", end_marker)
            if close != -1:
                return data[start : close + 2].decode("utf-8", errors="ignore")

    start = data.find(b"<x:xmpmeta")
    if start != -1:
        end = data.find(b"</x:xmpmeta>", start)
        if end != -1:
            end += len(b"</x:xmpmeta>")
            return data[start:end].decode("utf-8", errors="ignore")

    return ""


def _collect_metadata_text(pdf_path: Path) -> str:
    """Gather all searchable text from PDF metadata, XMP, and info dict."""
    parts: list[str] = []

    try:
        reader = PdfReader(str(pdf_path), strict=False)

        meta = reader.metadata
        if meta:
            for key in meta:
                val = meta.get(key)  # type: ignore[call-overload]
                if val:
                    parts.append(str(val))

        xmp_text = _extract_xmp_text(reader)
        if xmp_text:
            parts.append(xmp_text)
    except PdfReadError:
        pass

    if not any("xmp" in p.lower() or "adobe" in p.lower() for p in parts):
        fallback = _extract_xmp_fallback(pdf_path)
        if fallback:
            parts.append(fallback)

    try:
        raw = pdf_path.read_bytes()[:16384].decode("latin-1", errors="ignore")
        parts.append(raw)
    except OSError:
        pass

    return " ".join(parts).lower()


def classify_pdf(text: str) -> tuple[PdfVerdict, list[str]]:
    """Classify PDF based on metadata keywords."""
    matched: list[str] = []
    has_skia = REAL_KEYWORD in text

    for kw in FAKE_KEYWORDS:
        if kw in text:
            matched.append(kw)

    if has_skia and matched:
        return PdfVerdict.FAKE, matched

    if has_skia and not matched:
        matched.append(REAL_KEYWORD)
        return PdfVerdict.REAL, matched

    if matched:
        return PdfVerdict.FAKE, matched

    return PdfVerdict.UNKNOWN, matched


def analyze_single_pdf(pdf_path: Path, display_name: str | None = None) -> PdfAnalysisResult:
    """Analyze one PDF file and return its verdict."""
    filename = display_name or pdf_path.name

    try:
        reader = PdfReader(str(pdf_path), strict=False)

        producer = creator = ""
        parts: list[str] = []

        meta = reader.metadata
        if meta:
            for key in meta:
                val = meta.get(key)  # type: ignore[call-overload]
                if val:
                    parts.append(str(val))
            producer = str(meta.get("/Producer", "") or "")
            creator = str(meta.get("/Creator", "") or "")

        xmp_text = _extract_xmp_text(reader)
        if xmp_text:
            parts.append(xmp_text)

        if not any("xmp" in p.lower() or "adobe" in p.lower() for p in parts):
            fallback = _extract_xmp_fallback(pdf_path)
            if fallback:
                parts.append(fallback)

        try:
            raw = pdf_path.read_bytes()[:16384].decode("latin-1", errors="ignore")
            parts.append(raw)
        except OSError:
            pass

        text = " ".join(parts).lower()
        verdict, matched = classify_pdf(text)

        return PdfAnalysisResult(
            filename=filename,
            verdict=verdict,
            producer=producer,
            creator=creator,
            matched_keywords=matched,
        )
    except Exception as exc:
        logger.exception("Failed to analyze %s", filename)
        return PdfAnalysisResult(
            filename=filename,
            verdict=PdfVerdict.ERROR,
            error_message=str(exc),
        )


def _analyze_with_timeout(pdf_path: Path, display_name: str | None = None) -> PdfAnalysisResult:
    """Run analysis in a single-worker pool so we can enforce a timeout."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(analyze_single_pdf, pdf_path, display_name)
        try:
            return future.result(timeout=ANALYSIS_TIMEOUT_SECONDS)
        except FuturesTimeoutError:
            logger.warning("Analysis timed out for %s", pdf_path.name)
            return PdfAnalysisResult(
                filename=pdf_path.name,
                verdict=PdfVerdict.ERROR,
                error_message=f"Analysis timed out after {ANALYSIS_TIMEOUT_SECONDS}s",
            )


def analyze_pdfs(
    pdf_items: list[tuple[Path, str]],
    on_progress: Callable[[int, int], None] | None = None,
) -> list[PdfAnalysisResult]:
    """
    Analyze multiple PDFs in parallel with timeout protection.

    Each item is (path, display_name). Calls on_progress(completed, total) after each file.
    """
    if not pdf_items:
        return []

    total = len(pdf_items)
    results: list[PdfAnalysisResult | None] = [None] * total
    completed = 0

    workers = min(MAX_WORKERS, total)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(_analyze_with_timeout, path, name): idx
            for idx, (path, name) in enumerate(pdf_items)
        }

        for future in as_completed(future_map):
            idx = future_map[future]
            path, name = pdf_items[idx]
            try:
                results[idx] = future.result(timeout=ANALYSIS_TIMEOUT_SECONDS + 10)
            except FuturesTimeoutError:
                results[idx] = PdfAnalysisResult(
                    filename=name,
                    verdict=PdfVerdict.ERROR,
                    error_message="Worker timed out",
                )
            except Exception as exc:
                logger.exception("Unexpected error analyzing %s", name)
                results[idx] = PdfAnalysisResult(
                    filename=name,
                    verdict=PdfVerdict.ERROR,
                    error_message=str(exc),
                )

            completed += 1
            if on_progress:
                on_progress(completed, total)

    return [r for r in results if r is not None]
