import json
import re
import io
import zipfile
from typing import Dict, List, Optional
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from weasyprint import HTML

from .database import Base, engine, get_db
from .models import Exam, GradingResult, Student, StudentAnswer
from .services.pdf_parser import extract_rubric_from_pdf, extract_text_from_pdf
from .services.answer_parser import parse_answer_text
from .services.grading_service import grade_basic, merge_llm_results
from .services.llm_service import grade_with_gemini
from .services.rubric_parser import _extract_articles, _extract_cases, parse_rubric
from .ui import UI_HTML

app = FastAPI(title="Civil Law Grading API (Minimal)")

_CONTEXT_STORE: Dict[str, Dict[str, object]] = {}

Base.metadata.create_all(bind=engine)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://grading-civillaw-pss-9x3q.onrender.com",
        "https://grading-civillaw-pss-front.onrender.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StudentCreate(BaseModel):
    student_id: str
    name: str


class StudentUpdate(BaseModel):
    student_id: str
    name: str


class ExamUpdate(BaseModel):
    name: str


class ExamCreate(BaseModel):
    name: str


class ResultUpdate(BaseModel):
    result_json: dict


class ExportPdfRequest(BaseModel):
    answer_ids: List[int]
    mode: str


class RubricSectionNode(BaseModel):
    label: str
    title: str
    points: Optional[float] = None
    content: str
    sub_sections: Optional[List["RubricSectionNode"]] = None


RubricSectionNode.model_rebuild()


class RubricProblemPayload(BaseModel):
    id: str
    total_points: Optional[float] = None
    sections: List[RubricSectionNode]


class RubricContextPayload(BaseModel):
    fact_pattern: str
    question: str


class RubricCreatePayload(BaseModel):
    exam_id: int
    context: List[RubricContextPayload]
    problems: List[RubricProblemPayload]


# 프론트엔드와 동일: 헤딩(I. 문제의 제기 등)은 줄바꿈 유지, 나머지 줄은 공백으로 이어 붙임
_HEADING_RE = re.compile(
    r"^\s*(?!제\d+(?:조|항|호)(?:\s|$))"
    r"(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}\.|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}(?=\s|$)|\d+\.|\(\d+\)|\([가나다라마바사아자차카타파하]\))"
)


def normalize_answer_for_upload(text: str) -> str:
    if not (text or "").strip():
        return (text or "").strip()
    lines = re.split(r"\r?\n", text)
    result_lines: List[str] = []
    current_paragraph: List[str] = []

    def flush_paragraph() -> None:
        if current_paragraph:
            result_lines.append(" ".join(current_paragraph).strip())
            current_paragraph.clear()

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            flush_paragraph()
            continue
        if _HEADING_RE.match(line):
            flush_paragraph()
            result_lines.append(line)
            continue
        current_paragraph.append(line)
    flush_paragraph()
    return "\n".join(result_lines)


def _normalize_stored_answer_text(answer_text: str) -> str:
    """DB에 저장된 '[문제 1]\\n...\\n\\n[문제 2]\\n...' 형식을 블록별로 정규화."""
    if not (answer_text or "").strip():
        return answer_text or ""
    # [문제 N] 구간별로 분리 (정규식으로 세 블록 추출)
    m = re.match(
        r"\[문제\s*1\]\s*(.*?)\s*\[문제\s*2\]\s*(.*?)\s*\[문제\s*3\]\s*(.*)$",
        answer_text.strip(),
        re.DOTALL,
    )
    if not m:
        return normalize_answer_for_upload(answer_text)
    p1, p2, p3 = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
    return (
        "[문제 1]\n"
        + normalize_answer_for_upload(p1)
        + "\n\n[문제 2]\n"
        + normalize_answer_for_upload(p2)
        + "\n\n[문제 3]\n"
        + normalize_answer_for_upload(p3)
    )


def _flatten_sections_from_payload(
    problems: List[RubricProblemPayload],
) -> List[Dict[str, object]]:
    sections: List[Dict[str, object]] = []

    def visit(
        problem_id: str,
        section: RubricSectionNode,
        depth: int,
        label_path: List[str],
    ) -> None:
        labels = [problem_id, *label_path, section.label]
        section_id = ".".join([label for label in labels if label])
        combined = f"{section.title}\n{section.content}".strip()
        sections.append(
            {
                "id": section_id,
                "level": depth,
                "label": section.label,
                "title": section.title,
                "points": section.points,
                "content": section.content,
                "problem_num": problem_id,
                "articles": _extract_articles(combined),
                "cases": _extract_cases(combined),
            }
        )
        for child in section.sub_sections or []:
            visit(problem_id, child, depth + 1, [*label_path, section.label])

    for problem in problems:
        for section in problem.sections:
            visit(problem.id, section, 1, [])

    return sections


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}


@app.get("/ui", response_class=HTMLResponse)
def ui_page():
    return UI_HTML


@app.post("/parse/pdf")
async def parse_pdf(file: UploadFile = File(...)) -> dict:
    file_bytes = await file.read()
    return extract_text_from_pdf(file_bytes)


@app.post("/parse/rubric")
async def parse_rubric_endpoint(file: UploadFile = File(...)) -> dict:
    file_bytes = await file.read()
    rubric_payload = extract_rubric_from_pdf(file_bytes)
    return parse_rubric(rubric_payload["text"], rubric_payload.get("tables"))


@app.post("/parse/answer")
async def parse_answer(file: UploadFile = File(...)) -> dict:
    file_bytes = await file.read()
    pdf_text = extract_text_from_pdf(file_bytes)["text"]
    return parse_answer_text(pdf_text)


@app.post("/grade/preview")
async def grade_preview(
    rubric: UploadFile = File(...),
    model_answer: Optional[UploadFile] = File(None),
    student_answer: Optional[UploadFile] = File(None),
) -> dict:
    rubric_payload = extract_rubric_from_pdf(await rubric.read())
    rubric_data = parse_rubric(rubric_payload["text"], rubric_payload.get("tables"))

    result = {
        "rubric": rubric_data,
        "model_answer": None,
        "student_answer": None,
    }

    if model_answer is not None:
        model_text = extract_text_from_pdf(await model_answer.read())["text"]
        result["model_answer"] = parse_answer_text(model_text)

    if student_answer is not None:
        student_text = extract_text_from_pdf(await student_answer.read())["text"]
        result["student_answer"] = parse_answer_text(student_text)

    return result


@app.post("/grade/basic")
async def grade_basic_endpoint(
    rubric: UploadFile = File(...),
    student_answer: UploadFile = File(...),
) -> dict:
    rubric_payload = extract_rubric_from_pdf(await rubric.read())
    rubric_data = parse_rubric(rubric_payload["text"], rubric_payload.get("tables"))

    student_text = extract_text_from_pdf(await student_answer.read())["text"]
    return grade_basic(rubric_data, student_text)


@app.post("/grade/hybrid")
async def grade_hybrid(
    rubric: UploadFile = File(...),
    model_answer: UploadFile = File(...),
    student_answer: UploadFile = File(...),
) -> dict:
    rubric_payload = extract_rubric_from_pdf(await rubric.read())
    rubric_data = parse_rubric(rubric_payload["text"], rubric_payload.get("tables"))

    model_text = extract_text_from_pdf(await model_answer.read())["text"]
    student_text = extract_text_from_pdf(await student_answer.read())["text"]

    base_result = grade_basic(rubric_data, student_text)
    llm_results = grade_with_gemini(
        rubric_sections=rubric_data.get("sections", []),
        model_answer=model_text,
        student_answer=student_text,
    )
    return merge_llm_results(base_result, llm_results)


@app.post("/context/create")
async def create_context(
    rubric: UploadFile = File(...),
    model_answer: UploadFile = File(...),
) -> dict:
    rubric_payload = extract_rubric_from_pdf(await rubric.read())
    rubric_data = parse_rubric(rubric_payload["text"], rubric_payload.get("tables"))
    model_text = extract_text_from_pdf(await model_answer.read())["text"]

    context_id = str(uuid4())
    _CONTEXT_STORE[context_id] = {
        "rubric": rubric_data,
        "model_answer": model_text,
    }
    return {"context_id": context_id}


@app.post("/grade/hybrid/context")
async def grade_hybrid_with_context(
    context_id: str,
    student_answer: UploadFile = File(...),
) -> dict:
    context = _CONTEXT_STORE.get(context_id)
    if context is None:
        return {"error": "context_id not found"}

    student_text = extract_text_from_pdf(await student_answer.read())["text"]
    rubric_data = context["rubric"]
    model_text = context["model_answer"]

    base_result = grade_basic(rubric_data, student_text)
    llm_results = grade_with_gemini(
        rubric_sections=rubric_data.get("sections", []),
        model_answer=model_text,
        student_answer=student_text,
    )
    return merge_llm_results(base_result, llm_results)


@app.post("/rubric/create")
def create_rubric(payload: RubricCreatePayload, db=Depends(get_db)) -> dict:
    exam = db.query(Exam).filter(Exam.id == payload.exam_id).first()
    if not exam:
        raise HTTPException(status_code=404, detail="exam not found")

    sections = _flatten_sections_from_payload(payload.problems)
    rubric_data = {
        "context": [item.model_dump() for item in payload.context],
        "problems": [problem.model_dump() for problem in payload.problems],
        "sections": sections,
        "meta": {"total_sections": len(sections)},
    }

    context_texts = [
        f"{item.fact_pattern}\n{item.question}".strip()
        for item in payload.context
        if item.fact_pattern or item.question
    ]
    exam.rubric_text = "\n\n".join(context_texts)
    exam.rubric_json = json.dumps(rubric_data, ensure_ascii=False)
    db.commit()
    db.refresh(exam)
    return {"exam_id": exam.id, "status": "saved"}


@app.post("/exams")
async def create_exam(
    name: str = Form(...),
    rubric: UploadFile = File(...),
    model_answer: Optional[UploadFile] = File(None),
    db=Depends(get_db),
) -> dict:
    rubric_payload = extract_rubric_from_pdf(await rubric.read())
    rubric_data = parse_rubric(rubric_payload["text"], rubric_payload.get("tables"))
    model_text = ""
    if model_answer is not None:
        model_text = extract_text_from_pdf(await model_answer.read())["text"]

    exam = Exam(
        name=name,
        rubric_text=rubric_payload["text"],
        rubric_json=json.dumps(rubric_data, ensure_ascii=False),
        model_answer_text=model_text,
    )
    db.add(exam)
    db.commit()
    db.refresh(exam)
    return {"exam_id": exam.id, "name": exam.name}


@app.post("/exams/simple")
def create_exam_simple(payload: ExamCreate, db=Depends(get_db)) -> dict:
    empty_rubric = {
        "context": [
            {"fact_pattern": "", "question": ""},
            {"fact_pattern": "", "question": ""},
            {"fact_pattern": "", "question": ""},
        ],
        "problems": [],
        "sections": [],
        "meta": {"total_sections": 0},
    }
    exam = Exam(
        name=payload.name,
        rubric_text="",
        rubric_json=json.dumps(empty_rubric, ensure_ascii=False),
        model_answer_text="",
    )
    db.add(exam)
    db.commit()
    db.refresh(exam)
    return {"exam_id": exam.id, "name": exam.name}


@app.get("/exams")
def list_exams(db=Depends(get_db)) -> dict:
    exams = db.query(Exam).order_by(Exam.id.desc()).all()
    return {
        "items": [
            {"id": exam.id, "name": exam.name, "created_at": exam.created_at}
            for exam in exams
        ]
    }


@app.get("/exams/{exam_id}/rubric_json")
def get_exam_rubric_json(exam_id: int, db=Depends(get_db)) -> dict:
    exam = db.query(Exam).filter(Exam.id == exam_id).first()
    if not exam:
        raise HTTPException(status_code=404, detail="exam not found")
    return {"exam_id": exam.id, "rubric_json": exam.rubric_json}


@app.put("/exams/{exam_id}")
def update_exam(exam_id: int, payload: ExamUpdate, db=Depends(get_db)) -> dict:
    exam = db.query(Exam).filter(Exam.id == exam_id).first()
    if not exam:
        raise HTTPException(status_code=404, detail="exam not found")
    exam.name = payload.name
    db.commit()
    db.refresh(exam)
    return {"exam_id": exam.id, "name": exam.name}


@app.delete("/exams/{exam_id}")
def delete_exam(exam_id: int, db=Depends(get_db)) -> dict:
    exam = db.query(Exam).filter(Exam.id == exam_id).first()
    if not exam:
        raise HTTPException(status_code=404, detail="exam not found")
    answer_ids = [
        answer.id
        for answer in db.query(StudentAnswer).filter(StudentAnswer.exam_id == exam_id).all()
    ]
    if answer_ids:
        db.query(GradingResult).filter(GradingResult.answer_id.in_(answer_ids)).delete(
            synchronize_session=False
        )
        db.query(StudentAnswer).filter(StudentAnswer.id.in_(answer_ids)).delete(
            synchronize_session=False
        )
    db.delete(exam)
    db.commit()
    return {"deleted": True, "exam_id": exam_id}


@app.post("/students")
def create_student(payload: StudentCreate, db=Depends(get_db)) -> dict:
    existing = db.query(Student).filter(Student.student_id == payload.student_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="student_id already exists")
    student = Student(student_id=payload.student_id, name=payload.name)
    db.add(student)
    db.commit()
    db.refresh(student)
    return {"student_id": student.id, "name": student.name}


@app.put("/students/{student_id}")
def update_student(student_id: int, payload: StudentUpdate, db=Depends(get_db)) -> dict:
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="student not found")
    duplicate = (
        db.query(Student)
        .filter(Student.student_id == payload.student_id, Student.id != student_id)
        .first()
    )
    if duplicate:
        raise HTTPException(status_code=400, detail="student_id already exists")
    student.student_id = payload.student_id
    student.name = payload.name
    db.commit()
    db.refresh(student)
    return {"student_id": student.id, "name": student.name}


@app.get("/students")
def list_students(db=Depends(get_db)) -> dict:
    students = db.query(Student).order_by(Student.id.desc()).all()
    return {
        "items": [
            {
                "id": student.id,
                "student_id": student.student_id,
                "name": student.name,
                "created_at": student.created_at,
            }
            for student in students
        ]
    }


@app.post("/answers")
async def upload_answer(
    exam_id: int = Form(...),
    student_id: int = Form(...),
    file: UploadFile = File(...),
    db=Depends(get_db),
) -> dict:
    exam = db.query(Exam).filter(Exam.id == exam_id).first()
    if not exam:
        raise HTTPException(status_code=404, detail="exam not found")
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="student not found")

    raw_text = extract_text_from_pdf(await file.read())["text"]
    answer_text = normalize_answer_for_upload(raw_text)
    print(f"[DEBUG] Extracted text preview (first 500 chars): {answer_text[:500]}")
    answer = StudentAnswer(exam_id=exam.id, student_id=student.id, answer_text=answer_text)
    db.add(answer)
    db.commit()
    db.refresh(answer)
    return {"answer_id": answer.id}


@app.post("/answers/text")
def upload_answer_text(
    exam_id: int = Form(...),
    student_id: int = Form(...),
    problem1_text: str = Form(...),
    problem2_text: str = Form(...),
    problem3_text: str = Form(...),
    db=Depends(get_db),
) -> dict:
    exam = db.query(Exam).filter(Exam.id == exam_id).first()
    if not exam:
        raise HTTPException(status_code=404, detail="exam not found")
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="student not found")

    p1 = normalize_answer_for_upload(problem1_text.strip())
    p2 = normalize_answer_for_upload(problem2_text.strip())
    p3 = normalize_answer_for_upload(problem3_text.strip())
    answer_text = f"[문제 1]\n{p1}\n\n[문제 2]\n{p2}\n\n[문제 3]\n{p3}"
    print(f"[DEBUG] Text answer length: {len(answer_text)} chars")
    answer = StudentAnswer(exam_id=exam.id, student_id=student.id, answer_text=answer_text)
    db.add(answer)
    db.commit()
    db.refresh(answer)
    return {"answer_id": answer.id}


@app.post("/answers/normalize-all")
def normalize_all_answers(db=Depends(get_db)) -> dict:
    """DB에 이미 저장된 모든 답안의 answer_text를 문단 정규화(헤딩 유지, 나머지 줄 합침)로 일괄 수정."""
    answers = db.query(StudentAnswer).all()
    updated = 0
    for answer in answers:
        if not (answer.answer_text or "").strip():
            continue
        new_text = _normalize_stored_answer_text(answer.answer_text)
        if new_text != answer.answer_text:
            answer.answer_text = new_text
            updated += 1
    db.commit()
    return {"total": len(answers), "updated": updated}


@app.get("/answers/{answer_id}")
def get_answer(answer_id: int, db=Depends(get_db)) -> dict:
    answer = db.query(StudentAnswer).filter(StudentAnswer.id == answer_id).first()
    if not answer:
        raise HTTPException(status_code=404, detail="answer not found")
    return {"answer_id": answer.id, "answer_text": answer.answer_text}


@app.get("/answers")
def list_answers(
    exam_id: Optional[int] = None,
    student_id: Optional[int] = None,
    db=Depends(get_db),
) -> dict:
    query = db.query(StudentAnswer)
    if exam_id is not None:
        query = query.filter(StudentAnswer.exam_id == exam_id)
    if student_id is not None:
        query = query.filter(StudentAnswer.student_id == student_id)
    answers = query.order_by(StudentAnswer.id.desc()).all()

    items = []
    for answer in answers:
        has_result = answer.grading_result is not None
        items.append(
            {
                "id": answer.id,
                "exam_id": answer.exam_id,
                "student_id": answer.student_id,
                "created_at": answer.created_at,
                "has_result": has_result,
            }
        )
    return {"items": items}


def _save_grading_result(db, answer_id: int, result_json: str) -> None:
    """채점 결과 저장. 기존 행이 있으면 갱신, 없으면 INSERT. 시퀀스 꼬임 시 재시도로 업데이트."""
    row = db.query(GradingResult).filter(GradingResult.answer_id == answer_id).first()
    if row:
        row.result_json = result_json
    else:
        db.add(GradingResult(answer_id=answer_id, result_json=result_json))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        row = db.query(GradingResult).filter(GradingResult.answer_id == answer_id).first()
        if row:
            row.result_json = result_json
            db.commit()
        else:
            raise


@app.post("/grade/run")
def grade_run(
    answer_id: int,
    use_llm: bool = True,
    db=Depends(get_db),
) -> dict:
    answer = db.query(StudentAnswer).filter(StudentAnswer.id == answer_id).first()
    if not answer:
        raise HTTPException(status_code=404, detail="answer not found")
    exam = db.query(Exam).filter(Exam.id == answer.exam_id).first()
    if not exam:
        raise HTTPException(status_code=404, detail="exam not found")

    rubric_data = json.loads(exam.rubric_json)
    print(f"[DEBUG] Starting grading for answer_id={answer_id}, use_llm={use_llm}")
    print(f"[DEBUG] Rubric sections count: {len(rubric_data.get('sections', []))}")
    base_result = grade_basic(rubric_data, answer.answer_text)
    print(f"[DEBUG] Base result score_details count: {len(base_result.get('score_details', []))}")

    final_result = base_result
    if use_llm:
        print("[DEBUG] Calling LLM...")
        llm_results = grade_with_gemini(
            rubric_sections=rubric_data.get("sections", []),
            model_answer=exam.model_answer_text or "",
            student_answer=answer.answer_text,
        )
        print(f"[DEBUG] LLM returned {len(llm_results)} results")
        final_result = merge_llm_results(base_result, llm_results)

    _save_grading_result(db, answer.id, json.dumps(final_result, ensure_ascii=False))
    return final_result


@app.get("/results/{answer_id}")
def get_result(answer_id: int, db=Depends(get_db)) -> dict:
    result = (
        db.query(GradingResult)
        .filter(GradingResult.answer_id == answer_id)
        .first()
    )
    if not result:
        raise HTTPException(status_code=404, detail="result not found")
    return json.loads(result.result_json)


@app.put("/results/{answer_id}")
def update_result(answer_id: int, payload: ResultUpdate, db=Depends(get_db)) -> dict:
    result = (
        db.query(GradingResult)
        .filter(GradingResult.answer_id == answer_id)
        .first()
    )
    if not result:
        raise HTTPException(status_code=404, detail="result not found")
    result.result_json = json.dumps(payload.result_json, ensure_ascii=False)
    db.commit()
    db.refresh(result)
    return {"answer_id": answer_id, "status": "updated"}


def _split_by_problem_headings(text: str) -> Dict[str, str]:
    chunks: Dict[str, str] = {}
    order: List[str] = []
    lines = text.splitlines()
    heading_regex = re.compile(r"^\s*(?:\[)?(?:문제|문|설문)\s*(\d+)\s*[\]\.\):]?\s*(.*)$")
    current: Optional[str] = None
    buffer: List[str] = []

    def flush() -> None:
        nonlocal buffer
        if not current:
            buffer = []
            return
        content = "\n".join(buffer).strip()
        if content:
            chunks[current] = content
        buffer = []

    for line in lines:
        match = heading_regex.match(line.strip())
        if match:
            flush()
            current = match.group(1)
            if current not in order:
                order.append(current)
            buffer = [line]
            trailing = match.group(2).strip()
            if trailing:
                buffer.append(trailing)
            continue
        buffer.append(line)
    flush()
    return chunks


def _build_score_tree(score_details: List[dict]) -> Dict[str, dict]:
    by_problem: Dict[str, dict] = {}
    for detail in score_details:
        section_id = detail.get("section_id", "")
        if not section_id:
            continue
        problem_id = section_id.split(".")[0]
        if problem_id not in by_problem:
            by_problem[problem_id] = {"nodes": {}, "roots": []}
        by_problem[problem_id]["nodes"][section_id] = {**detail, "children": []}

    for problem_id, data in by_problem.items():
        nodes = data["nodes"]
        for section_id in list(nodes.keys()):
            parts = section_id.split(".")
            parent_id = ".".join(parts[:-1]) if len(parts) > 1 else ""
            if parent_id and parent_id in nodes:
                nodes[parent_id]["children"].append(section_id)
            else:
                data["roots"].append(section_id)
    return by_problem


def _compute_problem_totals(score_details: List[dict]) -> Dict[str, Dict[str, float]]:
    totals: Dict[str, Dict[str, float]] = {}
    for detail in score_details:
        if not detail.get("is_leaf", False):
            continue
        section_id = detail.get("section_id", "")
        if not section_id:
            continue
        problem_id = section_id.split(".")[0]
        if problem_id not in totals:
            totals[problem_id] = {"score": 0.0, "max": 0.0}
        totals[problem_id]["score"] += float(detail.get("score", 0) or 0)
        totals[problem_id]["max"] += float(detail.get("max_points", 0) or 0)
    return totals


def _render_pdf_html(records: List[dict]) -> str:
    pages: List[str] = []
    for record in records:
        exam = record["exam"]
        student = record["student"]
        answer_text = record["answer_text"] or ""
        score_details = record["score_details"]
        chunks = _split_by_problem_headings(answer_text)
        score_tree = _build_score_tree(score_details)
        totals = _compute_problem_totals(score_details)
        total_score = sum(v["score"] for v in totals.values())
        total_max = sum(v["max"] for v in totals.values())

        for pid in ["1", "2", "3"]:
            problem_totals = totals.get(pid, {"score": 0.0, "max": 0.0})
            header = f"""
              <div class=\"header\">
                <div class=\"title\">{exam['name']}</div>
                <div class=\"meta\">학번/이름: {student['student_id']} {student['name']}</div>
                <div class=\"meta\">문제별 점수: 1({totals.get('1', {'score':0,'max':0})['score']:.2f}/{totals.get('1', {'score':0,'max':0})['max']:.2f}) |
                2({totals.get('2', {'score':0,'max':0})['score']:.2f}/{totals.get('2', {'score':0,'max':0})['max']:.2f}) |
                3({totals.get('3', {'score':0,'max':0})['score']:.2f}/{totals.get('3', {'score':0,'max':0})['max']:.2f})
                </div>
                <div class=\"meta\">총점: {total_score:.2f}/{total_max:.2f}</div>
              </div>
            """
            answer_chunk = chunks.get(pid, answer_text)

            def render_node(node_id: str, depth: int) -> str:
                node = score_tree.get(pid, {}).get("nodes", {}).get(node_id, {})
                if not node:
                    return ""
                is_leaf = node.get("is_leaf", True)
                deductions = node.get("deductions", []) or []
                has_deductions = len(deductions) > 0
                note = node.get("llm", {}).get("note", "")
                deduction_html = ""
                if has_deductions:
                    deduction_html = "<ul class='deductions'>" + "".join(
                        [f"<li>- {d.get('reason','')} ({d.get('penalty',0)})</li>" for d in deductions]
                    ) + "</ul>"
                note_html = f"<div class='note {'note-bad' if has_deductions else 'note-ok'}'>{note}</div>" if note else ""
                score_line = (
                    f"<div class='score-line {'deducted' if has_deductions else ''}'>점수: {node.get('score',0)} / {node.get('max_points',0)}</div>"
                    if is_leaf else ""
                )
                children = "".join([render_node(child_id, depth + 1) for child_id in node.get("children", [])])
                return f"""
<div class="score-card" style="margin-left:{depth * 12}px">
  <div class="score-title">{node.get('section_id','')} {node.get('title','')}</div>
  {score_line}
  {deduction_html}
  {note_html}
</div>
{children}
"""

            tree_html = "".join(
                [render_node(root_id, 0) for root_id in score_tree.get(pid, {}).get("roots", [])]
            ) or "<div class='empty'>채점 내역이 없습니다.</div>"

            page = f"""
            <section class=\"page\">
              {header}
              <div class=\"problem\">문제 {pid} ({problem_totals['score']:.2f}/{problem_totals['max']:.2f})</div>
              <div class=\"content\">
                <div class=\"answer\"><pre>{answer_chunk}</pre></div>
                <div class=\"grading\">{tree_html}</div>
              </div>
            </section>
            """
            pages.append(page)

    html = f"""
    <html>
    <head>
      <meta charset=\"utf-8\" />
      <style>
        @font-face {{
          font-family: 'Noto Sans KR';
          src: url('https://fonts.gstatic.com/s/notosanskr/v27/Pj_zJwpxCwjiQLQabb69_8EabcghS6UT.ttf') format('truetype');
        }}
        @page {{ size: A4; margin: 12mm; }}
        body {{ font-family: 'Noto Sans KR', 'Malgun Gothic', 'Segoe UI', sans-serif; color: #111; font-size: 9pt; }}
        .page {{ page-break-after: always; }}
        .page:last-child {{ page-break-after: auto; }}
        .header {{ margin-bottom: 8px; }}
        .title {{ font-size: 12pt; font-weight: 600; }}
        .meta {{ font-size: 9pt; color: #444; }}
        .problem {{ font-size: 10pt; font-weight: 600; margin: 8px 0; }}
        .content {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
        .answer pre {{ background: #f8f8f8; padding: 10px; border-radius: 6px; white-space: pre-wrap; font-size: 8pt; }}
        .score-card {{ border: 1px solid #e5e7eb; border-radius: 6px; padding: 4px; margin-bottom: 4px; }}
        .score-title {{ font-weight: 600; margin-bottom: 4px; font-size: 7pt; }}
        .score-line.deducted {{ color: #dc2626; font-size: 7pt; }}
        .score-line {{ font-size: 7pt; }}
        .deductions {{ color: #dc2626; margin: 6px 0 0 18px; font-size: 7pt; }}
        .note {{ font-size: 7pt; margin-top: 4px; }}
        .note-ok {{ color: #444; }}
        .note-bad {{ color: #dc2626; }}
        .empty {{ color: #888; font-size: 7pt; }}
      </style>
    </head>
    <body>
      {''.join(pages)}
    </body>
    </html>
    """
    return html


@app.post("/results/export/pdf")
def export_results_pdf(payload: ExportPdfRequest, db=Depends(get_db)) -> Response:
    answer_ids = payload.answer_ids or []
    mode = payload.mode or "single"
    if not answer_ids:
        raise HTTPException(status_code=400, detail="answer_ids required")

    answers = (
        db.query(StudentAnswer)
        .filter(StudentAnswer.id.in_(answer_ids))
        .all()
    )
    answer_map = {answer.id: answer for answer in answers}
    records: List[dict] = []
    for answer_id in answer_ids:
        answer = answer_map.get(answer_id)
        if not answer:
            continue
        exam = db.query(Exam).filter(Exam.id == answer.exam_id).first()
        student = db.query(Student).filter(Student.id == answer.student_id).first()
        result = (
            db.query(GradingResult)
            .filter(GradingResult.answer_id == answer.id)
            .first()
        )
        if not exam or not student or not result:
            continue
        record = {
            "exam": {"id": exam.id, "name": exam.name},
            "student": {"id": student.id, "student_id": student.student_id, "name": student.name},
            "answer_text": answer.answer_text,
            "score_details": json.loads(result.result_json).get("score_details", []),
        }
        records.append(record)

    if not records:
        raise HTTPException(status_code=404, detail="no records")

    if mode == "batch":
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for record in records:
                html = _render_pdf_html([record])
                pdf_bytes = HTML(string=html).write_pdf()
                filename = f"{record['student']['student_id']}_{record['student']['name']}.pdf"
                zf.writestr(filename, pdf_bytes)
        zip_bytes = buffer.getvalue()
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="grading_selected.zip"'},
        )

    html = _render_pdf_html(records)
    pdf_bytes = HTML(string=html).write_pdf()
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="grading_selected.pdf"'},
    )


@app.delete("/answers/{answer_id}")
def delete_answer(answer_id: int, db=Depends(get_db)) -> dict:
    answer = db.query(StudentAnswer).filter(StudentAnswer.id == answer_id).first()
    if not answer:
        raise HTTPException(status_code=404, detail="answer not found")
    db.query(GradingResult).filter(GradingResult.answer_id == answer_id).delete()
    db.delete(answer)
    db.commit()
    return {"message": "deleted"}


@app.delete("/students/{student_id}")
def delete_student(student_id: int, db=Depends(get_db)) -> dict:
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="student not found")
    answer_ids = [a.id for a in db.query(StudentAnswer).filter(StudentAnswer.student_id == student_id).all()]
    for aid in answer_ids:
        db.query(GradingResult).filter(GradingResult.answer_id == aid).delete()
    db.query(StudentAnswer).filter(StudentAnswer.student_id == student_id).delete()
    db.delete(student)
    db.commit()
    return {"message": "deleted"}


@app.get("/results")
def list_results(
    exam_id: Optional[int] = None,
    student_id: Optional[int] = None,
    db=Depends(get_db),
) -> dict:
    query = (
        db.query(GradingResult, StudentAnswer, Student, Exam)
        .join(StudentAnswer, GradingResult.answer_id == StudentAnswer.id)
        .join(Student, StudentAnswer.student_id == Student.id)
        .join(Exam, StudentAnswer.exam_id == Exam.id)
    )
    if exam_id is not None:
        query = query.filter(StudentAnswer.exam_id == exam_id)
    if student_id is not None:
        query = query.filter(StudentAnswer.student_id == student_id)

    items = []
    for result, answer, student, exam in query.order_by(GradingResult.id.desc()).all():
        payload = json.loads(result.result_json)
        score_details = payload.get("score_details", [])
        leaf_details = [d for d in score_details if d.get("is_leaf") is True]
        if not leaf_details:
            leaf_details = score_details
        total_score = sum(d.get("score", 0) for d in leaf_details)
        total_max = sum(d.get("max_points", 0) for d in leaf_details)
        items.append(
            {
                "answer_id": answer.id,
                "exam_id": exam.id,
                "exam_name": exam.name,
                "student_id": student.id,
                "student_name": student.name,
                "total_score": round(total_score, 2),
                "total_max": round(total_max, 2),
                "created_at": result.created_at,
            }
        )
    return {"items": items}
