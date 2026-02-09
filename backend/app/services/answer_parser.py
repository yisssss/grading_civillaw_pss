import re
from typing import Dict, List, Optional, Tuple

from .text_normalizer import normalize_text

ROMAN_UNICODE_MAP = {
    "Ⅰ": "I",
    "Ⅱ": "II",
    "Ⅲ": "III",
    "Ⅳ": "IV",
    "Ⅴ": "V",
    "Ⅵ": "VI",
    "Ⅶ": "VII",
    "Ⅷ": "VIII",
    "Ⅸ": "IX",
    "Ⅹ": "X",
}


def _normalize_roman(label: str) -> str:
    return ROMAN_UNICODE_MAP.get(label, label)


def _detect_heading(line: str) -> Optional[Tuple[int, str, str]]:
    patterns = [
        (1, r"^(?P<label>[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)\.\s*(?P<title>.*)$"),
        (1, r"^(?P<label>[IVX]+)\.\s*(?P<title>.*)$"),
        (2, r"^(?P<label>\d+)\.\s*(?P<title>.*)$"),
        (3, r"^(?P<label>[가나다라마바사아자차카타파하])\.\s*(?P<title>.*)$"),
    ]
    for level, pattern in patterns:
        match = re.match(pattern, line)
        if match:
            label = match.group("label")
            title = match.group("title").strip()
            if level == 1:
                label = _normalize_roman(label)
            return level, label, title
    return None


PROBLEM_HEADING_RE = re.compile(
    r"^\s*(?:\[)?(?:문제|문|설문)\s*(\d+)\s*[\]\.\):]?\s*(.*)$"
)


def clean_student_ocr(text: str) -> str:
    """텍스트를 있는 그대로 반환 (최소한의 클리닝만)"""
    return text.strip()


def split_by_problem_headings(text: str) -> Dict[str, str]:
    chunks: Dict[str, str] = {}
    current_num: Optional[str] = None
    buffer: List[str] = []

    def flush() -> None:
        nonlocal buffer, current_num
        if current_num is None:
            buffer = []
            return
        content = "\n".join(buffer).strip()
        if content:
            chunks[current_num] = content
        buffer = []

    for line in text.splitlines():
        match = PROBLEM_HEADING_RE.match(line.strip())
        if match:
            flush()
            current_num = match.group(1)
            buffer = [line]
            trailing = match.group(2).strip()
            if trailing:
                buffer.append(trailing)
            continue
        buffer.append(line)

    flush()
    return chunks


def segment_student_answer(text: str) -> Dict[str, str]:
    return {}


def parse_answer_text(text: str) -> Dict[str, object]:
    normalized = clean_student_ocr(text)
    lines = [line for line in normalized.splitlines() if line.strip()]
    segments = segment_student_answer(normalized)
    problem_chunks = split_by_problem_headings(normalized)
    return {
        "text": normalized,
        "segments": segments,
        "problem_chunks": problem_chunks,
        "stats": {
            "char_count": len(normalized),
            "line_count": len(lines),
            "segment_count": len(segments),
            "problem_count": len(problem_chunks),
        },
    }
