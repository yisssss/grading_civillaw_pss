from datetime import datetime
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from .database import Base


class Exam(Base):
    __tablename__ = "exams"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    rubric_text = Column(Text, nullable=False)
    rubric_json = Column(Text, nullable=False)
    model_answer_text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    answers = relationship("StudentAnswer", back_populates="exam")


class Student(Base):
    __tablename__ = "students"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(String(50), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    answers = relationship("StudentAnswer", back_populates="student")


class StudentAnswer(Base):
    __tablename__ = "student_answers"

    id = Column(Integer, primary_key=True, index=True)
    exam_id = Column(Integer, ForeignKey("exams.id"), nullable=False)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    answer_text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    exam = relationship("Exam", back_populates="answers")
    student = relationship("Student", back_populates="answers")
    grading_result = relationship("GradingResult", back_populates="answer", uselist=False)


class GradingResult(Base):
    __tablename__ = "grading_results"

    id = Column(Integer, primary_key=True, index=True)
    answer_id = Column(Integer, ForeignKey("student_answers.id"), nullable=False, unique=True)
    result_json = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    answer = relationship("StudentAnswer", back_populates="grading_result")
