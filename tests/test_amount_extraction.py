"""Tests for bill amount extraction from receipt PDF text."""
from __future__ import annotations

from analyzer import extract_bill_amount_from_text


class TestExtractAmount:
    def test_pathao_format(self):
        text = (
            "Ride #JI9STM\n"
            "July 23, 2026 \u09f3 176.31\n"
            "05:25 AM\n"
            "Sub Total 222.82\n"
            "Safety Coverage 3.00\n"
            "Fare Saved -24.51\n"
            "Promo \n -25.00\n"
            "Total \u09f3 176.31\n"
            "Paid via Cash Payment\n"
        )
        assert extract_bill_amount_from_text(text) == 176.31

    def test_uber_format(self):
        text = (
            "Jul 1, 2026\n"
            "Thanks for riding, Julkernaine\n"
            "Total BDT\u00a0371.19\n"
            "Trip fare BDT\u00a0361.19\n"
            "Booking Fee \n BDT\u00a010.00\n"
            "Payments\n"
        )
        assert extract_bill_amount_from_text(text) == 371.19

    def test_ignores_sub_total(self):
        text = "Sub Total 222.82\nSomething 999\n"
        assert extract_bill_amount_from_text(text) is None

    def test_no_amount(self):
        assert extract_bill_amount_from_text("no receipt here") is None

    def test_empty(self):
        assert extract_bill_amount_from_text("") is None

    def test_commas_in_amount(self):
        text = "Total \u09f3 1,500.50\n"
        assert extract_bill_amount_from_text(text) == 1500.50

    def test_integer_total(self):
        text = "Total \u09f3 500\n"
        assert extract_bill_amount_from_text(text) == 500.0

    def test_totals_word_is_not_total(self):
        assert extract_bill_amount_from_text("Totals 100\n") is None

    def test_total_with_unit_word_is_not_amount(self):
        assert extract_bill_amount_from_text("Total rides 5\n") is None

    def test_negative_total_rejected(self):
        assert extract_bill_amount_from_text("Total -5.00\n") is None

    def test_total_mid_paragraph_currency(self):
        text = "Thanks for riding\nTotal BDT\u00a0371.19\nTrip fare 361.19"
        assert extract_bill_amount_from_text(text) == 371.19

    def test_total_followed_by_other_text(self):
        assert extract_bill_amount_from_text("Total \u09f3 100 later more\n") == 100.0

    def test_first_total_line_wins(self):
        text = "Total \u09f3 10\nGrand Total \u09f3 99\n"
        assert extract_bill_amount_from_text(text) == 10.0

    def test_currency_symbols(self):
        assert extract_bill_amount_from_text("Total $12.50\n") == 12.50
        assert extract_bill_amount_from_text("Total TK 75\n") == 75.0
        assert extract_bill_amount_from_text("Total 55.25\n") == 55.25
