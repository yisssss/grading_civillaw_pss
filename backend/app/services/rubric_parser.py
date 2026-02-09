import re
from typing import Dict, List, Optional, Tuple


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


def _extract_points(text: str) -> Optional[float]:
    match = re.search(r"\((\d+(?:\.\d+)?)\s*점\)", text)
    if match:
        return float(match.group(1))
    return None


def _strip_points(text: str) -> str:
    return re.sub(r"\(\d+(?:\.\d+)?\s*점\)", "", text).strip()


def _clean_line(line: str) -> str:
    return re.sub(r"\s+", " ", line or "").strip()


def _is_page_marker(line: str) -> bool:
    if re.match(r"^--\s*\d+\s*of\s*\d+\s*--$", line):
        return True
    if re.match(r"^-+\s*\d+\s*-+$", line):
        return True
    return False


def _detect_heading(line: str) -> Optional[Tuple[int, str, str]]:
    line = _clean_line(line)
    l1 = re.match(r"^(?P<label>[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+)\.\s*(?P<title>.*)", line)
    if l1:
        return 1, _normalize_roman(l1.group("label")), l1.group("title").strip()
    l2 = re.match(r"^(?P<label>\d+)\.\s+(?P<title>[^0-9].*)", line)
    if l2:
        return 2, l2.group("label"), l2.group("title").strip()
    l3 = re.match(r"^(?P<label>[가-하])\.\s*(?P<title>.*)", line)
    if l3:
        return 3, l3.group("label"), l3.group("title").strip()
    return None


def _unique_keep_order(items: List[str]) -> List[str]:
    seen = set()
    ordered = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


def _extract_articles(text: str) -> List[str]:
    patterns = [
        r"민법\s*제\s*\d+조(?:\s*제\s*\d+항)?",
        r"제\s*\d+조(?:\s*제\s*\d+항)?",
    ]
    results = []
    for pattern in patterns:
        results.extend(re.findall(pattern, text))
    return _unique_keep_order(results)


def _extract_cases(text: str) -> List[str]:
    patterns = [
        r"대판\s*\d{4}다\d+",
        r"대판\s*\d{4}\.\d{1,2}\.\d{1,2}[,]?\s*\d{2,4}다\d+",
        r"대법원\s*\d{4}다\d+",
    ]
    results = []
    for pattern in patterns:
        results.extend(re.findall(pattern, text))
    return _unique_keep_order(results)


def _parse_table_sections(tables: List[List[List[str]]]) -> List[Dict[str, object]]:
    sections: List[Dict[str, object]] = []
    path_stack: List[str] = []
    for table in tables:
        for row in table:
            if not row:
                continue
            cells = [cell.strip() if cell else "" for cell in row]
            row_text = " ".join([cell for cell in cells if cell]).strip()
            if not row_text:
                continue
            heading = _detect_heading(cells[0] or row_text)
            if not heading:
                continue
            level, label, title, points = heading
            if len(path_stack) < level:
                path_stack.extend([""] * (level - len(path_stack)))
            path_stack[level - 1] = label
            path_stack = path_stack[:level]
            section_id = ".".join([part for part in path_stack if part])

            remaining = " ".join([cell for cell in cells[1:] if cell]).strip()
            if points is None:
                points = _extract_points(row_text) or _extract_points(remaining)
                if points is None:
                    match = re.search(r"\b(\d{1,2})\b", remaining)
                    if match:
                        points = int(match.group(1))

            sections.append(
                {
                    "id": section_id,
                    "level": level,
                    "label": label,
                    "title": title,
                    "points": points,
                    "content": remaining,
                }
            )
    return sections


def parse_rubric_v2(text: str) -> Dict[str, object]:
    raw_lines = text.splitlines()
    cleaned_lines = [_clean_line(line) for line in raw_lines]

    start_index = 0
    for idx, line in enumerate(cleaned_lines):
        if re.search(r"\[제\s*\d+\s*문\]", line) or line.startswith("<문제>") or line.startswith("<사실관계>"):
            start_index = idx
            break
        if re.search(r"\[문제\s*\d+\.에\s*관하여\]", line):
            start_index = idx
            break

    lines = [line for line in cleaned_lines[start_index:] if line]

    context_data = {"fact_patterns": [], "questions": []}
    problems: List[Dict[str, object]] = []

    full_text = "\n".join(lines)
    context_data["fact_patterns"] = re.findall(
        r"<(?:사실관계|추가된 사실관계|변형된 사실관계)[^>]*>(.*?)(?=<문제>|\[문제|$)",
        full_text,
        re.DOTALL,
    )

    questions: List[str] = []
    question_buffer: List[str] = []
    in_question = False
    for line in lines:
        if _is_page_marker(line):
            continue
        if re.match(r"^<문제>", line):
            if in_question and question_buffer:
                questions.append("\n".join(question_buffer).strip())
            in_question = True
            question_buffer = [line]
            continue
        if re.search(r"\[문제\s*\d+\.에\s*관하여\]", line):
            if in_question and question_buffer:
                questions.append("\n".join(question_buffer).strip())
            in_question = False
            question_buffer = []
            continue
        if in_question:
            question_buffer.append(line)

    if in_question and question_buffer:
        questions.append("\n".join(question_buffer).strip())

    context_data["questions"] = questions

    current_problem: Optional[Dict[str, object]] = None
    current_section: Optional[Dict[str, object]] = None
    path_stack: List[str] = []

    for line in lines:
        if _is_page_marker(line):
            continue
        prob_match = re.search(
            r"\[문제\s*(\d+)\.에\s*관하여\]\s*(?:\((\d+(?:\.\d+)?)점\))?\s*(.*)",
            line,
        )
        if prob_match:
            current_problem = {
                "problem_num": prob_match.group(1),
                "total_points": float(prob_match.group(2)) if prob_match.group(2) else None,
                "sections": [],
            }
            trailing = prob_match.group(3).strip(" -")
            if trailing:
                current_problem["intro"] = trailing
            problems.append(current_problem)
            path_stack = [prob_match.group(1)]
            current_section = None
            continue

        if not current_problem:
            continue

        heading = _detect_heading(line)
        if heading:
            level, label, title = heading
            points = _extract_points(title)
            clean_title = _strip_points(title)

            if len(path_stack) > level:
                path_stack = path_stack[: level + 1]
            while len(path_stack) <= level:
                path_stack.append("")
            path_stack[level] = label
            section_id = ".".join([p for p in path_stack if p])

            current_section = {
                "id": section_id,
                "level": level,
                "label": label,
                "title": clean_title,
                "points": points,
                "content": "",
                "problem_num": current_problem["problem_num"],
            }
            current_problem["sections"].append(current_section)
            continue

        if current_section:
            content = current_section["content"]
            current_section["content"] = f"{content}\n{line}".strip()
            if current_section["points"] is None:
                points = _extract_points(line)
                if points is not None:
                    current_section["points"] = points

    sections: List[Dict[str, object]] = []
    for problem in problems:
        sections.extend(problem.get("sections", []))

    for section in sections:
        combined = f"{section.get('title', '')}\n{section.get('content', '')}".strip()
        section["articles"] = _extract_articles(combined)
        section["cases"] = _extract_cases(combined)

    return {
        "context": context_data,
        "problems": problems,
        "sections": sections,
        "meta": {"total_sections": len(sections)},
    }


def parse_rubric(text: str, tables: Optional[List[List[List[str]]]] = None) -> Dict[str, object]:
    parsed = parse_rubric_v2(text)
    sections = parsed.get("sections", [])
    context = parsed.get("context", {"fact_patterns": [], "questions": []})
    problems = parsed.get("problems", [])
    for section in sections:
        combined = f"{section.get('title', '')}\n{section.get('content', '')}".strip()
        section["articles"] = _extract_articles(combined)
        section["cases"] = _extract_cases(combined)

    return {
        "context": context,
        "problems": problems,
        "sections": sections,
        "meta": {"total_sections": len(sections)},
    }
