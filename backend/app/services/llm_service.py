import json
import re
import time
from datetime import timedelta
from typing import Dict, List, Optional

import google.generativeai as genai
from google.generativeai import caching
from google.generativeai.types import HarmCategory, HarmBlockThreshold

from ..config import get_settings
from .answer_parser import split_by_problem_headings
# from .answer_parser import clean_student_ocr  # No longer needed, split_by_problem_headings
from .grading_service import is_llm_relevant_section

INCOMPLETE_CAP_RATIO = 0.3
EVIDENCE_FAIL_CAP_RATIO = 0.5
MIN_EVIDENCE_LEN_DEFAULT = 30
MIN_EVIDENCE_LEN_CONCLUSION = 10


def _build_system_instruction(model_text: str = "") -> str:
    """시스템 인스트럭션 (캐시 가능)"""
    model_section = ""
    if model_text and model_text.strip():
        model_section = f"\n[채점 기준표표 참고]\n{model_text[:2000]}\n"
    
    return f"""너는 베테랑 변호사시험 채점 교수다. 학생의 답안 완성도를 엄격히 평가하라.

    해당 시험의 평균 정답률은 60%임을 감안해 엄격히 채점하라.

**[채점 항목별 상태 판별 규칙]**
1. **Missing (0.0점)**: 해당 항목에 대한 언급이 아예 없거나, '.', 'ㄴㄴ' 같은 의미 없는 문자만 있는 경우.
2. **Incomplete (감점)**: 서술을 시작했으나 결론을 내지 못했거나, 논리가 중간에 끊긴 경우 (예: '문제의 제기'만 쓰고 끝냄).
3. **Full (정상 채점)**: 논리적 완결성을 갖추고, 판례를 바탕으로 대입하여 채점기준표와 유사하고 정확하게 서술함.

**[강조 사항]**
- **[근거 문장 필수]**: 반드시 채점 사유로로 **'학생 답안'에서 그대로 복사한 문장 1~2개만** evidence에 넣어라. **채점기준표/문제지의 문장 인용 금지.** 한 문장은 **최대 20자**로 제한한다. 만약 학생 답안에서 근거를 찾을 수 없다면, 억지로 만들지 말고 반드시 `is_written: false`, `score: 0.0`, `evidence: ["X"]`로 응답하라.
- **[엄격 채점]**: 단순 언급(키워드만 스치는 경우)은 Full로 판단하지 말고 Incomplete로 처리하며, 점수는 최대 30%까지만 부여하라.
- **[감점 로직]**:
  - 결론 미작성: 해당 항목 배점의 70% 감점. (정수 단위로 반올림)
  - 논거 부족/중단: 배점의 50% 이상 감점. (정수 단위로 반올림)
  - note에서 감점을 언급하는 경우 deductions에 반드시 이유/penalty를 명시하라. 

**반드시 지켜야 할 규칙:**
- **[강조 표시]**: `__내용__`은 핵심 법리/개념. 판례를 바탕으로 대입하여 채점기준표와 유사하고 정확하게 작성했는지 엄격하게 일치불일치를 확인한다.
- **[목차 유연성]**: 학생이 번호/소제목을 잘못 표기해도 내용의 실질이 일치하면 인정{model_section}

출력 형식: 반드시 아래 스키마의 순수 JSON 리스트로만 응답하라. 코드블록, 추가 설명 금지.
[
  {{"section_id": "...", "writing_status": "Missing|Incomplete|Full", "is_written": true/false, "score": 0.0, "evidence": ["학생 답안 문장1", ...], "deductions": [{{"reason": "...", "penalty": 0.0}}], "note": "..."}},
  ...
]""".strip()


def _build_batch_prompt(batch: List[Dict[str, object]]) -> str:
    """배치별 채점 기준 (매번 다름)"""
    rubric_items = []
    for section in batch:
        content = section.get("content", "")
        rubric_items.append(
            f"[{section.get('id')}] {section.get('title')}: {content} ({section.get('points')}점)"
        )
    
    rubric_str = "\n".join(rubric_items)
    return f"""[채점 기준 리스트 - {len(batch)}개 항목]
{rubric_str}

위 항목들을 학생 답안에서 찾아 채점하라.""".strip()


def _is_meaningless_text(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    if re.fullmatch(r"[\.·…\s]+", stripped):
        return True
    if re.fullmatch(r"[ㄱ-ㅎㅏ-ㅣ]+", stripped):
        return True
    cleaned = re.sub(r"[^\w가-힣]", "", stripped)
    return len(cleaned) == 0


def _is_conclusion_section(section: Dict[str, object]) -> bool:
    title = str(section.get("title", ""))
    content = str(section.get("content", ""))
    return "결론" in title or "결론" in content


def _normalize_evidence_text(text: str) -> str:
    cleaned = re.sub(r"\s+", "", text)
    cleaned = re.sub(r"[^\w가-힣]", "", cleaned)
    return cleaned


def _evidence_in_student(evidence: List[str], student_text: str) -> bool:
    normalized_student = _normalize_evidence_text(student_text)
    for ev in evidence:
        ev_norm = _normalize_evidence_text(str(ev))
        if not ev_norm:
            continue
        if ev_norm in normalized_student:
            return True
        # OCR/문장부호 차이 대응: 앞/뒤 일부라도 매칭되면 인정
        if len(ev_norm) >= 12:
            if ev_norm[:10] in normalized_student or ev_norm[-10:] in normalized_student:
                return True
    return False


def _normalize_evidence(evidence: List[str]) -> List[str]:
    normalized: List[str] = []
    for ev in evidence:
        ev_text = str(ev).strip()
        if not ev_text:
            continue
        if ev_text == "X":
            continue
        normalized.append(ev_text[:25])
    return normalized


def _extract_json(text: str) -> Optional[str]:
    if not text:
        return None
    cleaned = text.strip()
    cleaned = re.sub(r"^```json\\s*|^```\\s*|```$", "", cleaned, flags=re.IGNORECASE | re.MULTILINE)
    cleaned = cleaned.strip()
    if cleaned.startswith("[") and cleaned.endswith("]"):
        return cleaned
    if cleaned.startswith("{") and cleaned.endswith("}"):
        return cleaned
    start_list = cleaned.find("[")
    end_list = cleaned.rfind("]")
    if start_list != -1 and end_list != -1 and end_list > start_list:
        return cleaned[start_list : end_list + 1]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        return cleaned[start : end + 1]
    return None


def _truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n...[truncated]"


def _round_to_half(value: float) -> float:
    return round(value * 2) / 2.0


def _normalize_note_tone(note: object) -> str:
    """LLM이 생성한 note 내용을 유지하면서 종결 어미만 '~함.' 형태로 통일."""
    text = str(note or "").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"[.?!]+$", "", text).strip()
    text = re.sub(r"(입니다|됩니다|되었다|했다|하였다|다|요)$", "", text).strip()
    if text.endswith("됨"):
        text = f"{text[:-1]}함"
    elif text.endswith("함"):
        pass
    else:
        text = f"{text}함"
    return f"{text}."


def _normalize_deductions_and_score(
    parsed: Dict[str, object],
    section: Dict[str, object],
    evidence_is_valid: bool = True,
) -> Dict[str, object]:
    max_points = float(section.get("points", 0) or 0)
    max_points = _round_to_half(max_points)
    writing_status = str(parsed.get("writing_status", "Full"))

    raw_deductions = parsed.get("deductions", [])
    deductions: List[Dict[str, object]] = []
    if isinstance(raw_deductions, list):
        for raw in raw_deductions:
            if not isinstance(raw, dict):
                continue
            reason = str(raw.get("reason", "")).strip() or "감점"
            try:
                penalty = float(raw.get("penalty", 0) or 0)
            except (TypeError, ValueError):
                penalty = 0.0
            penalty = _round_to_half(max(0.0, penalty))
            if penalty <= 0:
                continue
            deductions.append({"reason": reason, "penalty": penalty})

    try:
        llm_score = float(parsed.get("score", max_points) or 0)
    except (TypeError, ValueError):
        llm_score = 0.0
    llm_score = _round_to_half(max(0.0, min(max_points, llm_score)))

    if writing_status == "Missing" or parsed.get("is_written") is False:
        total_penalty = max_points
        deductions = [{"reason": "해당 내용 미작성", "penalty": total_penalty}] if max_points > 0 else []
        final_score = 0.0
    else:
        if deductions:
            total_penalty = _round_to_half(sum(float(d.get("penalty", 0) or 0) for d in deductions))
            total_penalty = min(total_penalty, max_points)
            score_from_penalty = _round_to_half(max(0.0, max_points - total_penalty))
            final_score = _round_to_half(min(llm_score, score_from_penalty))
        else:
            final_score = llm_score
            total_penalty = _round_to_half(max(0.0, max_points - final_score))
            if total_penalty > 0:
                deductions = [{"reason": "평가 기준 반영 감점", "penalty": total_penalty}]

        if writing_status == "Incomplete":
            score_cap = _round_to_half(max_points * INCOMPLETE_CAP_RATIO)
            if final_score > score_cap:
                additional_penalty = _round_to_half(final_score - score_cap)
                final_score = score_cap
                if additional_penalty > 0:
                    deductions.append({"reason": "논리 전개 불완전", "penalty": additional_penalty})
        elif not evidence_is_valid:
            # 근거가 없거나 학생 답안에 근거 매칭이 안 되면 Full이라도 상한 적용
            evidence_cap = _round_to_half(max_points * EVIDENCE_FAIL_CAP_RATIO)
            if final_score > evidence_cap:
                additional_penalty = _round_to_half(final_score - evidence_cap)
                final_score = evidence_cap
                if additional_penalty > 0:
                    deductions.append({"reason": "근거 문장 불충분", "penalty": additional_penalty})

        total_penalty = _round_to_half(max(0.0, max_points - final_score))

    parsed["deductions"] = deductions
    parsed["score"] = final_score
    parsed["note"] = _normalize_note_tone(parsed.get("note"))
    return parsed


def grade_with_gemini(
    rubric_sections: List[Dict[str, object]],
    model_answer: str,
    student_answer: str,
) -> List[Dict[str, object]]:
    settings = get_settings()
    api_key = settings.get("GOOGLE_API_KEY", "")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY가 설정되지 않았습니다.")

    genai.configure(api_key=api_key)
    retries = int(settings.get("LLM_RETRIES", 2))
    backoff = float(settings.get("LLM_BACKOFF", 1.5))

    cleaned_model = model_answer.strip()
    cleaned_student = student_answer.strip()

    # 채점 대상 섹션 필터링 (최하위 항목만)
    target_sections = [s for s in rubric_sections if is_llm_relevant_section(s, rubric_sections)]
    
    # 필터링 결과 상세 로그
    print(f"[DEBUG LLM] Total rubric sections: {len(rubric_sections)}, LLM target sections (leaf only): {len(target_sections)}")
    print(f"[DEBUG LLM] Student answer length: {len(cleaned_student)} chars")
    print(f"[DEBUG LLM] Filtered sections IDs: {[s.get('id') for s in target_sections]}")
    
    # 부모 항목이 섞여 있는지 확인
    parent_sections = [s for s in rubric_sections if not is_llm_relevant_section(s, rubric_sections) and s.get("points") is not None]
    if parent_sections:
        print(f"[DEBUG LLM] Parent sections excluded: {[s.get('id') for s in parent_sections]}")
    
    # Context Caching: 시스템 인스트럭션 + 학생 답안을 캐시에 저장
    system_instruction = _build_system_instruction(cleaned_model)
    
    try:
        print("[DEBUG LLM] Creating context cache...")
        cached_content = caching.CachedContent.create(
            model=settings.get("LLM_MODEL"),
            system_instruction=system_instruction,
            contents=[
                {
                    "role": "user",
                    "parts": [{"text": f"[학생 답안 전문]\n{cleaned_student}"}]
                }
            ],
            ttl=timedelta(hours=1),
        )
        print(f"[DEBUG LLM] Cache created: {cached_content.name}")
    except Exception as exc:
        print(f"[DEBUG LLM] Cache creation failed: {exc}, falling back to non-cached mode")
        cached_content = None
    
    # 문항별로 배치 분할 (problem_num 기준)
    problem_batches: Dict[str, List[Dict[str, object]]] = {}
    for section in target_sections:
        problem_num = str(section.get("problem_num", "unknown"))
        if problem_num not in problem_batches:
            problem_batches[problem_num] = []
        problem_batches[problem_num].append(section)
    
    print(f"[DEBUG LLM] Split into {len(problem_batches)} problem batches: {list(problem_batches.keys())}")
    
    results = []
    
    # 문제별 텍스트 청크 (문제 헤딩 기준)
    problem_chunks = split_by_problem_headings(cleaned_student)

    safety_settings = [
        {
            "category": HarmCategory.HARM_CATEGORY_HARASSMENT,
            "threshold": HarmBlockThreshold.BLOCK_NONE,
        },
        {
            "category": HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            "threshold": HarmBlockThreshold.BLOCK_NONE,
        },
        {
            "category": HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            "threshold": HarmBlockThreshold.BLOCK_NONE,
        },
        {
            "category": HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            "threshold": HarmBlockThreshold.BLOCK_NONE,
        },
    ]

    for problem_num, batch in problem_batches.items():
        print(f"[DEBUG LLM] Processing problem {problem_num}, {len(batch)} sections: {[s.get('id') for s in batch]}")
        batch_prompt = _build_batch_prompt(batch)

        raw_text = ""
        parsed_list = []
        attempt = 0

        # 문제별 텍스트에서 의미 없는 입력 필터링
        problem_text = problem_chunks.get(problem_num, cleaned_student)
        if _is_meaningless_text(problem_text):
            print(f"[DEBUG LLM] Problem {problem_num}: meaningless text detected, skipping LLM")
            parsed_list = [
                {
                    "section_id": section.get("id"),
                    "writing_status": "Missing",
                    "is_written": False,
                    "score": 0.0,
                    "deductions": [{"reason": "의미 없는 텍스트 입력", "penalty": section.get("points", 0)}],
                    "note": "의미 없는 입력(., ㄴㄴ 등)으로 미작성 처리",
                }
                for section in batch
            ]
        else:
            while attempt <= retries:
                try:
                    print(f"[DEBUG LLM] API call attempt {attempt + 1}")

                    if cached_content:
                        # 캐시 사용
                        model = genai.GenerativeModel.from_cached_content(cached_content)
                        response = model.generate_content(
                            batch_prompt,
                            generation_config={
                                "temperature": 0.2,
                                "max_output_tokens": 4096,
                            },
                            safety_settings=safety_settings,
                        )
                    else:
                        # 캐시 없이 실행
                        model = genai.GenerativeModel(
                            model_name=settings.get("LLM_MODEL"),
                            system_instruction=system_instruction,
                        )
                        full_prompt = f"[학생 답안 전문]\n{cleaned_student}\n\n{batch_prompt}"
                        response = model.generate_content(
                            full_prompt,
                            generation_config={
                                "temperature": 0.2,
                                "max_output_tokens": 4096,
                            },
                            safety_settings=safety_settings,
                        )

                    raw_text = (response.text or "").strip()
                    print(f"[DEBUG LLM] Raw response length: {len(raw_text)}")
                    print(f"[DEBUG LLM] Raw response: {raw_text[:1500]}")
                    json_text = _extract_json(raw_text) or ""
                    parsed_list = json.loads(json_text)
                    if not isinstance(parsed_list, list):
                        parsed_list = [parsed_list]
                    print(f"[DEBUG LLM] Successfully parsed {len(parsed_list)} results")
                    break
                except Exception as exc:  # noqa: BLE001
                    print(f"[DEBUG LLM] Error: {exc}")
                    if attempt == retries:
                        parsed_list = [
                            {
                                "section_id": section.get("id"),
                                "score": 0,
                                "deductions": [{"reason": f"LLM 실패: {exc}", "penalty": 0}],
                                "is_ambiguous": True,
                                "note": raw_text[:500] if raw_text else str(exc),
                            }
                            for section in batch
                        ]
                        break
                    time.sleep(backoff * (attempt + 1))
                    attempt += 1

        for section, parsed in zip(batch, parsed_list):
            if isinstance(parsed, dict):
                # 작성 여부 체크: is_written=false면 무조건 0점
                writing_status = parsed.get("writing_status")
                is_written = parsed.get("is_written", True)  # 기본값 True (하위 호환)
                if writing_status == "Missing":
                    is_written = False

                if not is_written:
                    parsed["score"] = 0.0
                    if "deductions" not in parsed or not parsed["deductions"]:
                        parsed["deductions"] = [{"reason": "해당 내용 미작성", "penalty": section.get("points", 0)}]
                    print(f"[DEBUG LLM] Section {section.get('id')}: NOT WRITTEN, forced score=0")
                # 근거 문장 검증: 부족/불일치 시 후처리에서 점수 상한 적용
                evidence_raw = parsed.get("evidence") if isinstance(parsed.get("evidence"), list) else []
                evidence = _normalize_evidence(evidence_raw)
                evidence_text = "".join(evidence)
                min_evidence_len = (
                    MIN_EVIDENCE_LEN_CONCLUSION if _is_conclusion_section(section) else MIN_EVIDENCE_LEN_DEFAULT
                )
                evidence_is_valid = True
                if not evidence or len(evidence_text.strip()) < min_evidence_len:
                    parsed["evidence"] = ["X"]
                    if "deductions" not in parsed:
                        parsed["deductions"] = []
                    evidence_is_valid = False
                    print(f"[DEBUG LLM] Section {section.get('id')}: NO EVIDENCE, skipping python override")
                elif not _evidence_in_student(evidence, cleaned_student):
                    parsed["evidence"] = ["X"]
                    if "deductions" not in parsed:
                        parsed["deductions"] = []
                    parsed["note"] = ""
                    evidence_is_valid = False
                    print(f"[DEBUG LLM] Section {section.get('id')}: EVIDENCE NOT IN STUDENT, skipping python override")
                else:
                    parsed["evidence"] = evidence

                if writing_status == "Incomplete":
                    # 중단된 답안: 기본 감점 적용 (없을 경우)
                    if "deductions" not in parsed or not parsed["deductions"]:
                        penalty = _round_to_half(float(section.get("points", 0)) * 0.7)
                        parsed["score"] = max(0.0, float(parsed.get("score", 0)) - penalty)
                        parsed["deductions"] = [{"reason": "논리 중단/결론 미작성", "penalty": penalty}]
                        print(f"[DEBUG LLM] Section {section.get('id')}: INCOMPLETE, penalty applied")
                    max_points = float(section.get("points", 0))
                    parsed["score"] = min(float(parsed.get("score", 0)), max_points * 0.3)
                parsed = _normalize_deductions_and_score(parsed, section, evidence_is_valid=evidence_is_valid)
                llm_result = parsed
            else:
                llm_result = {
                    "score": 0,
                    "deductions": [],
                    "is_ambiguous": True,
                    "note": "파싱 오류",
                }
            
            results.append(
                {
                    "section_id": section.get("id"),
                    "title": section.get("title"),
                    "max_points": float(section.get("points", 0)),
                    "llm_result": llm_result,
                }
            )
    
    # 캐시 정리
    if cached_content:
        try:
            cached_content.delete()
            print(f"[DEBUG LLM] Cache deleted: {cached_content.name}")
        except Exception as exc:
            print(f"[DEBUG LLM] Cache deletion failed: {exc}")

    print(f"[DEBUG] LLM returned {len(results)} results")
    return results
