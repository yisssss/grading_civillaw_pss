import re
from typing import Dict, List, Optional, Tuple

from .answer_parser import split_by_problem_headings

KEYWORD_STOPWORDS = {
    "사안",
    "여부",
    "논하고",
    "결론",
    "법원",
    "문제",
    "소결",
    "요건",
    "검토",
    "주장",
    "판단",
    "인용",
    "기각",
    "각하",
    "일부인용",
    "최근",
    "판례",
    "경우",
    "사안에서",
    "해당",
    "내용",
    "법률",
    "판시",
    "필요",
    "이유",
    "관련",
    "이상",
}


def _normalize_for_match(text: str) -> str:
    cleaned = re.sub(r"\s+", "", text)
    cleaned = re.sub(r"[^\w가-힣]", "", cleaned)
    return cleaned


def _extract_keywords(section: Dict[str, object], max_keywords: int = 8) -> List[str]:
    title = str(section.get("title", ""))
    content = str(section.get("content", ""))
    underlined = re.findall(r"__([^_]+)__", content)
    if underlined:
        return list(set(underlined))
    combined = f"{title} {content}".strip()
    words = re.findall(r"[가-힣]{2,}", combined)
    keywords = []
    for word in words:
        if word in KEYWORD_STOPWORDS:
            continue
        if word not in keywords:
            keywords.append(word)
        if len(keywords) >= max_keywords:
            break
    return keywords


def _contains_keyword(text: str, keyword: str) -> bool:
    return keyword in text


def _contains_article(text: str, article: str) -> bool:
    norm_text = _normalize_for_match(text)
    norm_article = _normalize_for_match(article)
    return norm_article in norm_text


def _extract_conclusion_label(text: str) -> Optional[str]:
    norm_text = _normalize_for_match(text)
    candidates = ["일부인용", "인용", "기각", "각하"]
    for label in candidates:
        if label in norm_text:
            return label
    if "전부인용" in norm_text:
        return "인용"
    return None


def _is_conclusion_section(section: Dict[str, object]) -> bool:
    title = str(section.get("title", ""))
    content = str(section.get("content", ""))
    return "결론" in title or "결론" in content


def _needs_llm(section: Dict[str, object]) -> bool:
    title = str(section.get("title", ""))
    content = str(section.get("content", ""))
    return "포섭" in title or "포섭" in content


def is_leaf_section(section_id: str, all_sections: List[Dict[str, object]]) -> bool:
    """해당 섹션이 최하위 항목(Leaf Node)인지 확인"""
    return not any(
        str(other.get("id", "")).startswith(f"{section_id}.")
        for other in all_sections
        if str(other.get("id", "")) != section_id
    )


def is_llm_relevant_section(section: Dict[str, object], all_sections: List[Dict[str, object]]) -> bool:
    """LLM 채점 대상: 점수가 있고 최하위 항목인 경우만"""
    points = section.get("points")
    if points is None or float(points) <= 0:
        return False
    section_id = str(section.get("id", ""))
    return is_leaf_section(section_id, all_sections)


def calculate_final_score(score_details: List[Dict[str, object]]) -> Tuple[float, float]:
    leaf_details = [d for d in score_details if d.get("is_leaf") is True]
    total_score = sum(float(d.get("score", 0)) for d in leaf_details)
    total_max = sum(float(d.get("max_points", 0)) for d in leaf_details)
    return total_score, total_max


def grade_basic(
    rubric: Dict[str, object],
    student_text: str,
) -> Dict[str, object]:
    score_details: List[Dict[str, object]] = []
    is_ambiguous = False
    llm_needed_sections: List[str] = []

    cleaned_text = student_text.strip()
    problem_chunks = split_by_problem_headings(cleaned_text)
    long_text = len(cleaned_text) >= 15000
    sections = rubric.get("sections", [])
    
    print(f"[DEBUG GRADE] Total sections: {len(sections)}")
    for sec in sections:
        print(f"[DEBUG GRADE] Section {sec.get('id')}: {sec.get('title')} - {sec.get('points')}점")

    def select_problem_text(section: Dict[str, object]) -> str:
        problem_num = str(section.get("problem_num", "")).strip()
        if problem_num and problem_num in problem_chunks:
            return problem_chunks[problem_num]
        if long_text and problem_chunks:
            return "\n\n".join(problem_chunks.values())
        return cleaned_text

    def is_leaf(section_id: str) -> bool:
        return not any(
            str(other.get("id", "")).startswith(f"{section_id}.")
            for other in sections
            if str(other.get("id", "")) != section_id
        )

    for section in sections:
        points = section.get("points")
        if points is None:
            continue

        section_id = str(section.get("id", ""))
        is_target = is_leaf(section_id)
        max_points = float(points)
        print(f"[DEBUG GRADE] Section {section_id}: points={max_points}, is_leaf={is_target}")
        if is_target:
            print("[DEBUG GRADE] -> Leaf section")
        else:
            print("[DEBUG GRADE] -> Parent section")
        # Python 규칙 기반 채점은 제거: LLM이 전담
        if _needs_llm(section):
            is_ambiguous = True
            llm_needed_sections.append(section_id)

        score_details.append(
            {
                "section_id": section_id,
                "title": section.get("title"),
                "max_points": max_points,
                "score": 0.0,
                "deductions": [],
                "keywords": [],
                "articles": section.get("articles", []),
                "is_leaf": is_target,
            }
        )

    total_score, total_max = calculate_final_score(score_details)
    human_note = f"총점 {round(total_score, 2)}/{round(total_max, 2)}"
    if llm_needed_sections:
        human_note += f" | 포섭 판단 LLM 필요 섹션: {', '.join(llm_needed_sections)}"

    return {
        "score_details": score_details,
        "is_ambiguous": is_ambiguous,
        "human_note": human_note,
    }


def merge_llm_results(
    base_result: Dict[str, object],
    llm_results: List[Dict[str, object]],
) -> Dict[str, object]:
    """
    LLM 채점 결과를 기본 채점 결과와 병합
    
    중요: llm_results는 이미 leaf 섹션만 포함하고 있음 (is_llm_relevant_section에서 필터링됨)
    따라서 llm_results에 있는 섹션은 무조건 최하위 항목이므로, 다시 is_leaf 판단 불필요
    """
    by_section = {item["section_id"]: item for item in llm_results}
    updated_details = []

    is_ambiguous = base_result.get("is_ambiguous", False)

    score_details = base_result.get("score_details", [])
    
    for item in score_details:
        section_id = item.get("section_id")

        llm_item = by_section.get(section_id)
        if llm_item:
            # LLM이 채점한 섹션 = 무조건 leaf
            llm_result = llm_item.get("llm_result", {})
            max_points = float(item.get("max_points", 0))
            llm_score = float(llm_result.get("score", item.get("score", 0)))
            item["deductions"] = llm_result.get("deductions", []) if isinstance(llm_result, dict) else []
            item["llm"] = llm_result
            item["score"] = max(0.0, min(max_points, llm_score))
            if llm_result.get("is_ambiguous"):
                is_ambiguous = True
        
        updated_details.append(item)

    total_score, total_max = calculate_final_score(updated_details)
    print(f"[DEBUG MERGE] Final score from leaf items: {total_score}/{total_max}")
    human_note = f"총점 {round(total_score, 2)}/{round(total_max, 2)}"
    return {
        "score_details": updated_details,
        "is_ambiguous": is_ambiguous,
        "human_note": human_note,
    }
