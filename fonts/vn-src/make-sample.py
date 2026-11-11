#!/usr/bin/env python3
"""Writes samples/vn-fonts.docx: runs in .VnTime / .VnTimeH (TCVN3 text stored as Latin-1 characters, the way Word
stores it), Times New Roman, Arial and Calibri, for checking the fonts of the pack in the preview and the PDF.
Usage: python -I make-sample.py <out.docx>"""
import json
import os
import sys
import unicodedata
import zipfile
from xml.sax.saxutils import escape

here = os.path.dirname(os.path.abspath(__file__))
codes = json.load(open(os.path.join(here, 'tcvn3.json'), encoding='utf-8'))['codes']
low, cap = {}, {}
for key, letters in codes.items():
    byte = int(key, 16)
    if len(letters) == 1:
        (cap if letters[0].isupper() else low)[letters[0]] = byte
    else:
        cap[letters[0]] = byte
        low[letters[1]] = byte


def tcvn3(text, all_caps=False):
    out = ''
    for ch in unicodedata.normalize('NFC', text):
        if all_caps:
            b = cap.get(ch.upper())
        else:
            b = low.get(ch, cap.get(ch))
        out += chr(b) if b else ch
    return out


def run(font, text, bold=False, size=28):
    rpr = '<w:rFonts w:ascii="%s" w:hAnsi="%s" w:cs="%s"/>%s<w:sz w:val="%d"/>' % (font, font, font, '<w:b/>' if bold else '', size)
    return '<w:r><w:rPr>%s</w:rPr><w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, escape(text))


def para(*runs):
    return '<w:p>%s</w:p>' % ''.join(runs)


text1 = 'Cộng hòa xã hội chủ nghĩa Việt Nam'
text2 = 'Trường Đại học Bách khoa Hà Nội — Thông báo số 25'
body = ''.join([
    para(run('Times New Roman', 'Times New Roman: ' + text1)),
    para(run('Arial', 'Arial: ' + text1)),
    para(run('Calibri', 'Calibri: ' + text1)),
    para(run('.VnTime', tcvn3(text1))),
    para(run('.VnTime', tcvn3(text2), bold=True)),
    para(run('.VnTimeH', tcvn3(text1, True))),
    para(run('.VnTimeH', tcvn3(text2, True), bold=True)),
])
doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
       '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>%s</w:body></w:document>' % body)
ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
