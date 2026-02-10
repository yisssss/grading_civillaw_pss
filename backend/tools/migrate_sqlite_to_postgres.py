import os
import sys
from typing import List, Type

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy import text

from app.models import Exam, GradingResult, Student, StudentAnswer
from app.database import Base


def _get_env(name: str, default: str = "") -> str:
    value = os.getenv(name, "").strip()
    return value if value else default


def _bulk_copy(
    source_session: Session,
    target_session: Session,
    model: Type[Base],
    label: str,
) -> int:
    rows = source_session.query(model).all()
    if not rows:
        print(f"[INFO] {label}: 0 rows")
        return 0

    payload = [
        {
            column.name: getattr(row, column.name)
            for column in model.__table__.columns
        }
        for row in rows
    ]
    target_session.bulk_insert_mappings(model, payload)
    target_session.commit()
    print(f"[INFO] {label}: {len(payload)} rows")
    return len(payload)


def main() -> int:
    source_url = _get_env("SOURCE_SQLITE_URL", "sqlite:///./backend/app.db")
    target_url = _get_env("TARGET_DATABASE_URL")

    if not target_url:
        print("[ERROR] TARGET_DATABASE_URL is required.")
        return 1

    print(f"[INFO] Source: {source_url}")
    print("[INFO] Target: (hidden)")

    source_engine = create_engine(
        source_url,
        connect_args={"check_same_thread": False} if source_url.startswith("sqlite") else {},
    )
    target_engine = create_engine(target_url)

    Base.metadata.create_all(bind=target_engine)

    SourceSession = sessionmaker(bind=source_engine)
    TargetSession = sessionmaker(bind=target_engine)

    with SourceSession() as source, TargetSession() as target:
        # Clear target DB first (user requested full reset)
        target.execute(
            text(
                "TRUNCATE TABLE grading_results, student_answers, students, exams "
                "RESTART IDENTITY CASCADE"
            )
        )
        target.commit()
        # Order matters because of foreign keys
        _bulk_copy(source, target, Exam, "exams")
        _bulk_copy(source, target, Student, "students")
        _bulk_copy(source, target, StudentAnswer, "student_answers")
        _bulk_copy(source, target, GradingResult, "grading_results")

    print("[INFO] Migration complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
