import json
from typing import Dict, List, Optional
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

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
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StudentCreate(BaseModel):
    student_id: str
    name: str


class ExamUpdate(BaseModel):
    name: str


class ExamCreate(BaseModel):
    name: str


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

    answer_text = extract_text_from_pdf(await file.read())["text"]
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

    answer_text = f"[문제 1]\n{problem1_text.strip()}\n\n[문제 2]\n{problem2_text.strip()}\n\n[문제 3]\n{problem3_text.strip()}"
    print(f"[DEBUG] Text answer length: {len(answer_text)} chars")
    answer = StudentAnswer(exam_id=exam.id, student_id=student.id, answer_text=answer_text)
    db.add(answer)
    db.commit()
    db.refresh(answer)
    return {"answer_id": answer.id}


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

    payload = json.dumps(final_result, ensure_ascii=False)
    existing = (
        db.query(GradingResult)
        .filter(GradingResult.answer_id == answer.id)
        .first()
    )
    if existing:
        existing.result_json = payload
    else:
        db.add(GradingResult(answer_id=answer.id, result_json=payload))
    db.commit()
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
