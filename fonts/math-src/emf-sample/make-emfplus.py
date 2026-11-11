#!/usr/bin/env python3
"""Writes test-plus.emf (EMF+ only: GDI+ font objects + DrawString) and test-plus.emz (the same, gzip) with text in
MT Extra / Symbol / Euclid Math Two / Euclid Math One / Euclid Fraktur, for checking the EMF+ and EMZ paths of
math-compat.mjs. The EMF+ family name is stored in EmfPlusObject (Font) records, not in LOGFONT records.
Usage: python -I make-emfplus.py <out-dir>"""
import gzip
import os
import struct
import sys

W, H = 600, 340  # pixels at 96 dpi


def pad4(b):
    return b + b'\0' * (-len(b) % 4)


def plus(type_, flags, data=b''):
    data = pad4(data)
    return struct.pack('<HHII', type_, flags, 12 + len(data), len(data)) + data


def font_object(oid, face, em=40.0):
    name = face.encode('utf-16-le')
    data = struct.pack('<IfIiII', 0xDBC01002, em, 2, 0, 0, len(face)) + name  # version, emSize, pixel unit, style, reserved, length
    return plus(0x4008, (6 << 8) | oid, data)


def draw_string(oid, text, x, y):
    s = text.encode('utf-16-le')
    data = struct.pack('<IIIffff', 0xFF000000, 0, len(text), x, y, 560.0, 55.0) + s  # black ARGB, no format, layout rect
    return plus(0x401C, 0x8000 | oid, data)


def emf(rows):
    recs = plus(0x4001, 0, struct.pack('<IIII', 0xDBC01002, 1, 96, 96))  # EmfPlusOnly header
    recs += plus(0x4030, 2, struct.pack('<f', 1.0))  # SetPageTransform, pixel
    for i, (face, text) in enumerate(rows):
        recs += font_object(i, face)
    for i, (face, text) in enumerate(rows):
        recs += draw_string(i, text, 10.0, 5.0 + 55.0 * i)
    recs += plus(0x4002, 0)  # EMF+ EndOfFile
    comment_data = b'EMF+' + recs
    comment = struct.pack('<III', 70, 12 + len(pad4(comment_data)), len(comment_data)) + pad4(comment_data)
    eof = struct.pack('<IIIII', 14, 20, 0, 16, 20)
    desc = 'office-wasm EMF+ test\0\0'.encode('utf-16-le')
    desc = pad4(desc)
    hdr_size = 88 + len(desc)
    total = hdr_size + len(comment) + len(eof)
    mm = lambda px: int(px / (96 / 25.4) * 100)  # 0.01 mm
    # EMR_HEADER: type, size, bounds (px), frame (0.01 mm), " EMF", version, bytes, records, handles, reserved,
    # description chars + offset, palette entries, device px, device mm
    header = struct.pack('<II4i4iIIIIHHIIIiiii', 1, hdr_size, 0, 0, W, H, 0, 0, mm(W), mm(H),
                         0x464D4520, 0x10000, total, 3, 1, 0, len(desc) // 2, 88, 0, 1024, 768, 270, 203)
    assert len(header) == 88, len(header)
    return header + desc + comment + eof


rows = [
    ('MT Extra', ''),
    ('MT Extra', 'ArVW'),
    ('Symbol', ''),
    ('Euclid Math Two', '\x84\x85AGk!'),
    ('Euclid Math One', 'ALR\xB4\xB6!'),
    ('Euclid Fraktur', 'Aabrh'),
]
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
data = emf(rows)
open(os.path.join(out, 'test-plus.emf'), 'wb').write(data)
open(os.path.join(out, 'test-plus.emz'), 'wb').write(gzip.compress(data, mtime=0))
print(len(data))
