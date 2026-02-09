from io import BytesIO
import re
from typing import Dict, List

import pdfplumber

from .text_normalizer import normalize_text


def extract_text_from_pdf(file_bytes: bytes) -> Dict[str, str]:
    text_chunks = []
    with pdfplumber.open(BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text() or ""
            if page_text.strip():
                text_chunks.append(page_text)

    combined_text = "\n\n".join(text_chunks).strip()
    return {"text": combined_text}


def _extract_underlined_text(page) -> str:
    """글자 하단에 선이 있는 경우 __text__ 형태로 변환"""
    chars = page.chars or []
    lines = page.lines or []
    text = ""

    for char in chars:
        is_underlined = any(
            abs(line.get("top", 0) - char.get("bottom", 0)) < 2 
            and line.get("x0", 0) <= char.get("x0", 0) <= line.get("x1", 0)
            for line in lines
        )
        char_text = char.get("text", "")
        text += f"__{char_text}__" if is_underlined else char_text

    return re.sub(r"__([^_]+)____([^_]+)__", r"__\1\2__", text)


def extract_rubric_from_pdf(file_bytes: bytes) -> Dict[str, object]:
    text_chunks: List[str] = []
    tables: List[List[List[str]]] = []
    with pdfplumber.open(BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = _extract_underlined_text(page)
            if page_text.strip():
                text_chunks.append(page_text)
            page_tables = page.extract_tables() or []
            tables.extend(page_tables)

    combined_text = "\n\n".join(text_chunks).strip()
    return {"text": normalize_text(combined_text), "tables": tables}
