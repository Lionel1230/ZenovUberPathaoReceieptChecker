"""Unit tests for the analyzer's classification and metadata helpers."""
from __future__ import annotations

import io

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, StreamObject

from analyzer import (
    PdfVerdict,
    _extract_xmp_fallback,
    analyze_pdfs,
    analyze_single_pdf,
    classify_pdf,
    extract_bill_amount,
    extract_bill_amount_from_stream,
)


class TestClassifyPdf:
    def test_real_when_only_skia(self):
        verdict, matched = classify_pdf("produced with skia/231")
        assert verdict == PdfVerdict.REAL
        assert "skia" in matched

    def test_fake_when_adobe(self):
        verdict, matched = classify_pdf("made with adobe pdf editor")
        assert verdict == PdfVerdict.FAKE
        assert "adobe" in matched

    def test_fake_when_skia_and_fake_keyword(self):
        verdict, matched = classify_pdf("skia engine but canva export")
        assert verdict == PdfVerdict.FAKE
        assert "canva" in matched

    def test_unknown_otherwise(self):
        verdict, matched = classify_pdf("nothing useful here")
        assert verdict == PdfVerdict.UNKNOWN
        assert matched == []


class TestXmpFallback:
    def test_xpacket_extracted(self, tmp_path):
        p = tmp_path / "a.pdf"
        p.write_bytes(b"junk<?xpacket begin=''?>hello<?xpacket end='w'?>more")
        assert "hello" in _extract_xmp_fallback(p)

    def test_xmpmeta_extracted(self, tmp_path):
        p = tmp_path / "b.pdf"
        p.write_bytes(b"<x:xmpmeta>world</x:xmpmeta>")
        assert _extract_xmp_fallback(p) == "<x:xmpmeta>world</x:xmpmeta>"

    def test_no_packet(self, tmp_path):
        p = tmp_path / "c.pdf"
        p.write_bytes(b"nothing here")
        assert _extract_xmp_fallback(p) == ""


class TestAnalyzeSinglePdf:
    def test_garbage_file_returns_error(self, tmp_path):
        p = tmp_path / "bad.pdf"
        p.write_bytes(b"this is not a pdf")
        result = analyze_single_pdf(p)
        assert result.verdict == PdfVerdict.ERROR
        assert result.filename == "bad.pdf"

    def test_blank_page_pdf_analyzed(self, tmp_path):
        p = tmp_path / "blank.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        with open(p, "wb") as f:
            writer.write(f)
        result = analyze_single_pdf(p)
        assert result.verdict in (PdfVerdict.REAL, PdfVerdict.FAKE, PdfVerdict.UNKNOWN)
        assert result.producer or result.creator or result.error_message

    def test_analyze_pdfs_empty(self):
        assert analyze_pdfs([]) == []

    def test_analyze_pdfs_with_display_name(self, tmp_path):
        p = tmp_path / "x.pdf"
        p.write_bytes(b"not a real pdf")
        results = analyze_pdfs([(p, "renamed.pdf")])
        assert results[0].filename == "renamed.pdf"


def _make_minimal_pdf(text: str) -> bytes:
    """Build a tiny single-page PDF whose page text is `text`."""
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    }))
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})
    })
    stream = StreamObject()
    stream.set_data(f"BT /F1 12 Tf 10 700 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    buf = io.BytesIO()
    writer.write(buf)
    data = buf.getvalue()
    PdfReader(io.BytesIO(data))  # sanity: must parse
    return data


class TestExtractFromPdfObjects:
    def test_extract_bill_amount_from_stream(self):
        pdf = _make_minimal_pdf("Total BDT 371.19")
        assert extract_bill_amount_from_stream(io.BytesIO(pdf)) == 371.19

    def test_extract_bill_amount_garbage_stream(self):
        assert extract_bill_amount_from_stream(io.BytesIO(b"garbage")) is None

    def test_extract_bill_amount_path(self, tmp_path):
        p = tmp_path / "r.pdf"
        p.write_bytes(_make_minimal_pdf("Total BDT 176.31"))
        assert extract_bill_amount(p) == 176.31

    def test_extract_bill_amount_garbage_path(self, tmp_path):
        p = tmp_path / "g.pdf"
        p.write_bytes(b"garbage")
        assert extract_bill_amount(p) is None
