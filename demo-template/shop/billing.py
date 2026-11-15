"""Invoice maths."""

TAX_RATE = 0.2


def invoice_total(items):
    """items: list of {"price": float, "qty": int}. Returns the total including tax, rounded to cents."""
    net = sum(i["price"] * i["qty"] for i in items)
    return round(net * (1 + TAX_RATE), 2)
