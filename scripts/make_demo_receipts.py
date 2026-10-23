"""Generates the demo receipts in docs/demo-receipts/ (run: python3 scripts/make_demo_receipts.py).

The website's automatic audit reads the PDF text and looks for two lines:
    Total Amount: <number> ETH
    Pay to wallet: <0x address>
so any receipt used with the site must contain them.

receipt1.pdf and receipt2.pdf are valid. receipt3.pdf is a fake (tampered) receipt that the
automatic audit rejects, because it pays the NGO's own wallet.
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "demo-receipts")

RECEIPTS = [
    {
        "file": "receipt1.pdf",
        "supplier": "Sharma Traders",
        "address": "Fancy Bazaar, Guwahati, Assam 781001",
        "invoice": "INV-2026-101",
        "date": "14 October 2026",
        "bill_to": "Assam Flood Relief (cause #1)",
        "items": [("Rice, 25 kg bag", "50", "0.08 ETH", "4.00 ETH"),
                  ("Transport to relief camp", "1", "1.00 ETH", "1.00 ETH")],
        "total": "5",
        "wallet": "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",  # Hardhat account #4
    },
    {
        "file": "receipt2.pdf",
        "supplier": "Gupta Tent House",
        "address": "Paltan Bazaar, Guwahati, Assam 781008",
        "invoice": "INV-2026-207",
        "date": "15 October 2026",
        "bill_to": "Assam Flood Relief (cause #1)",
        "items": [("Tarpaulin sheet, 12 x 15 ft", "40", "0.05 ETH", "2.00 ETH"),
                  ("Bamboo poles (set of 4)", "40", "0.025 ETH", "1.00 ETH")],
        "total": "3",
        "wallet": "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",  # Hardhat account #5
    },
    {
        # FAKE: a tampered copy of receipt1 whose payment wallet was changed to the NGO's own
        # wallet (account #1). The automatic audit blocks it: the NGO cannot pay itself.
        "file": "receipt3.pdf",
        "supplier": "Sharma Traders",
        "address": "Fancy Bazaar, Guwahati, Assam 781001",
        "invoice": "INV-2026-101",
        "date": "14 October 2026",
        "bill_to": "Assam Flood Relief (cause #1)",
        "items": [("Rice, 25 kg bag", "50", "0.08 ETH", "4.00 ETH"),
                  ("Transport to relief camp", "1", "1.00 ETH", "1.00 ETH")],
        "total": "5",
        "wallet": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",  # the NGO itself (account #1)
    },
]


def make(r):
    path = os.path.join(OUT_DIR, r["file"])
    # Never overwrite an existing receipt: each PDF embeds its creation time, so regenerating it
    # would change its SHA-256 fingerprint and it would no longer match the hash stored on-chain.
    if os.path.exists(path):
        print("exists, skipped", os.path.normpath(path))
        return
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    x = 20 * mm
    y = h - 25 * mm

    c.setFont("Helvetica-Bold", 18)
    c.drawString(x, y, r["supplier"])
    c.setFont("Helvetica", 10)
    c.drawString(x, y - 6 * mm, r["address"])
    c.setFont("Helvetica-Bold", 14)
    c.drawRightString(w - x, y, "TAX INVOICE")
    c.setFont("Helvetica", 10)
    c.drawRightString(w - x, y - 6 * mm, f"Invoice No: {r['invoice']}")
    c.drawRightString(w - x, y - 11 * mm, f"Date: {r['date']}")

    y -= 22 * mm
    c.line(x, y, w - x, y)
    y -= 8 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x, y, "Bill to:")
    c.setFont("Helvetica", 10)
    c.drawString(x + 18 * mm, y, r["bill_to"])

    # Items table
    y -= 12 * mm
    cols = [x, x + 95 * mm, x + 115 * mm, x + 145 * mm]
    c.setFont("Helvetica-Bold", 10)
    for col, head in zip(cols, ["Item", "Qty", "Rate", "Amount"]):
        c.drawString(col, y, head)
    c.line(x, y - 2.5 * mm, w - x, y - 2.5 * mm)
    c.setFont("Helvetica", 10)
    for item in r["items"]:
        y -= 8 * mm
        for col, val in zip(cols, item):
            c.drawString(col, y, val)
    y -= 5 * mm
    c.line(x, y, w - x, y)

    # The two lines the website's automatic audit reads
    y -= 10 * mm
    c.setFont("Helvetica-Bold", 12)
    c.drawString(x, y, f"Total Amount: {r['total']} ETH")
    y -= 8 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x, y, f"Pay to wallet: {r['wallet']}")

    y -= 14 * mm
    c.setFont("Helvetica", 9)
    c.drawString(x, y, "Payment to be made from the cause's smart contract on the Hardhat Local network (chain ID 31337).")
    c.drawString(x, y - 5 * mm, "Demonstration receipt for a college mini project. Test ETH only; no real money involved.")

    c.setFont("Helvetica-Oblique", 9)
    c.drawRightString(w - x, 30 * mm, f"For {r['supplier']} (authorised signatory)")
    c.save()
    print("written", os.path.normpath(path))


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for r in RECEIPTS:
        make(r)
