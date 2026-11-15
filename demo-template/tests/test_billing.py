from shop.billing import invoice_total


def test_invoice_total_adds_tax():
    assert invoice_total([{"price": 10.0, "qty": 2}]) == 24.0


def test_invoice_total_empty():
    assert invoice_total([]) == 0.0
