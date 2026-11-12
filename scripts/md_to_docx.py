#!/usr/bin/env python3
"""Convert the BP analysis markdown report to a formatted DOCX."""
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_LINE_SPACING
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor


def set_cn_font(run, name="PingFang SC"):
    run.font.name = name
    r = run._element
    rPr = r.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.append(rFonts)
    rFonts.set(qn("w:eastAsia"), name)


def add_hyperlink(paragraph, url, text):
    part = paragraph.part
    r_id = part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)
    new_run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "1F4E79")
    rPr.append(color)
    u = OxmlElement("w:u")
    u.set(qn("w:val"), "single")
    rPr.append(u)
    new_run.append(rPr)
    t = OxmlElement("w:t")
    t.text = text
    new_run.append(t)
    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)


INLINE_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
INLINE_CODE = re.compile(r"`([^`]+)`")
INLINE_BOLD = re.compile(r"\*\*([^*]+)\*\*")


def add_inline(paragraph, text, size=None):
    # Split on links first
    pos = 0
    for m in INLINE_LINK.finditer(text):
        if m.start() > pos:
            add_plain_inline(paragraph, text[pos:m.start()], size)
        add_hyperlink(paragraph, m.group(2), m.group(1))
        pos = m.end()
    if pos < len(text):
        add_plain_inline(paragraph, text[pos:], size)


def add_plain_inline(paragraph, text, size=None):
    # code segments
    pos = 0
    for m in INLINE_CODE.finditer(text):
        if m.start() > pos:
            add_bold_segments(paragraph, text[pos:m.start()], size)
        run = paragraph.add_run(m.group(1))
        run.font.name = "Consolas"
        run.font.size = Pt((size or 10.5) - 1)
        set_cn_font(run, "PingFang SC")
        pos = m.end()
    if pos < len(text):
        add_bold_segments(paragraph, text[pos:], size)


def add_bold_segments(paragraph, text, size=None):
    pos = 0
    for m in INLINE_BOLD.finditer(text):
        if m.start() > pos:
            r = paragraph.add_run(text[pos:m.start()])
            r.font.size = Pt(size or 10.5)
            set_cn_font(r)
        r = paragraph.add_run(m.group(1))
        r.bold = True
        r.font.size = Pt(size or 10.5)
        set_cn_font(r)
        pos = m.end()
    if pos < len(text):
        r = paragraph.add_run(text[pos:])
        r.font.size = Pt(size or 10.5)
        set_cn_font(r)


def shade_cell(cell, hex_color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    tcPr.append(shd)


def add_table(doc, rows):
    if not rows:
        return
    ncols = len(rows[0])
    table = doc.add_table(rows=len(rows), cols=ncols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = "Table Grid"
    for ri, row in enumerate(rows):
        for ci in range(ncols):
            cell = table.cell(ri, ci)
            cell.text = ""
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            value = row[ci] if ci < len(row) else ""
            add_inline(p, value, size=8.2)
            if ri == 0:
                for run in p.runs:
                    run.bold = True
                shade_cell(cell, "EAF1F8")
    # approximate widths
    width = Cm(17.0 / max(ncols, 1))
    for row in table.rows:
        for cell in row.cells:
            cell.width = width


def main():
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    lines = src.read_text(encoding="utf-8").splitlines()
    doc = Document()
    # page setup A4
    section = doc.sections[0]
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.0)
    section.right_margin = Cm(2.0)

    # base styles
    normal = doc.styles["Normal"]
    normal.font.name = "PingFang SC"
    normal.font.size = Pt(10.5)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")
    normal.paragraph_format.line_spacing = 1.25

    title_done = False
    i = 0
    in_code = False
    code_lines = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            if in_code:
                # flush code block
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Cm(0.5)
                p.paragraph_format.space_after = Pt(6)
                run = p.add_run("\n".join(code_lines))
                run.font.name = "Consolas"
                run.font.size = Pt(8.5)
                run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
                code_lines = []
                in_code = False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code_lines.append(line)
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        # table block
        if stripped.startswith("|"):
            table_rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                raw = lines[i].strip().strip("|")
                cells = [c.strip() for c in raw.split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells):
                    table_rows.append(cells)
                i += 1
            if table_rows:
                add_table(doc, table_rows)
                doc.add_paragraph().paragraph_format.space_after = Pt(2)
            continue

        if stripped == "---":
            i += 1
            continue

        if stripped.startswith("# "):
            text = stripped[2:].strip()
            if not title_done:
                p = doc.add_paragraph()
                p.paragraph_format.space_before = Pt(12)
                p.paragraph_format.space_after = Pt(4)
                r = p.add_run(text)
                r.bold = True
                r.font.size = Pt(22)
                r.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
                set_cn_font(r)
                title_done = True
            else:
                doc.add_heading(text, level=1)
            i += 1
            continue
        if stripped.startswith("## "):
            doc.add_heading(stripped[3:].strip(), level=2)
            i += 1
            continue
        if stripped.startswith("### "):
            doc.add_heading(stripped[4:].strip(), level=3)
            i += 1
            continue
        if stripped.startswith("#### "):
            doc.add_heading(stripped[5:].strip(), level=4)
            i += 1
            continue
        if stripped.startswith("> "):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6)
            p.paragraph_format.right_indent = Cm(0.6)
            p.paragraph_format.space_after = Pt(3)
            add_inline(p, stripped[2:].strip(), size=9.5)
            for r in p.runs:
                r.italic = True
                r.font.color.rgb = RGBColor(0x44, 0x44, 0x44)
            i += 1
            continue
        if re.match(r"^[-*] ", stripped):
            p = doc.add_paragraph(style="List Bullet")
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, stripped[2:].strip())
            i += 1
            continue
        if re.match(r"^\d+\. ", stripped):
            p = doc.add_paragraph(style="List Number")
            p.paragraph_format.space_after = Pt(1)
            add_inline(p, re.sub(r"^\d+\. ", "", stripped))
            i += 1
            continue

        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(3)
        add_inline(p, stripped)
        i += 1

    # footer page number
    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = 1
    run = fp.add_run()
    fldChar1 = OxmlElement("w:fldChar"); fldChar1.set(qn("w:fldCharType"), "begin")
    instrText = OxmlElement("w:instrText"); instrText.set(qn("xml:space"), "preserve"); instrText.text = "PAGE"
    fldChar2 = OxmlElement("w:fldChar"); fldChar2.set(qn("w:fldCharType"), "end")
    run._r.append(fldChar1); run._r.append(instrText); run._r.append(fldChar2)
    run.font.size = Pt(8)

    doc.save(dst)
    print("saved", dst)


if __name__ == "__main__":
    main()
