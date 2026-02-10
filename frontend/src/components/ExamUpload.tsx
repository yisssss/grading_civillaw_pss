"use client";

import { useEffect, useRef, useState } from "react";
import { examsApi, gradeApi } from "@/lib/api";
import RubricBuilder from "@/components/RubricBuilder";

export default function ExamUpload() {
  const [exams, setExams] = useState<any[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [newExamName, setNewExamName] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const [examStats, setExamStats] = useState<Record<number, { totalPoints: number | null; avgScore: number | null }>>(
    {},
  );
  const [rubricEditExamId, setRubricEditExamId] = useState<number | null>(null);

  const formatDateOnly = (value?: string) => {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const extractTotalPoints = (raw: any): number | null => {
    let parsed = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) return null;
    const problems = Array.isArray(parsed.problems) ? parsed.problems : [];
    const totals = problems
      .map((problem: any) => problem?.total_points)
      .filter((value: any) => typeof value === "number");
    if (totals.length) {
      return totals.reduce((sum: number, value: number) => sum + value, 0);
    }
    return null;
  };

  const loadExamStats = async (items: any[]) => {
    const entries = await Promise.all(
      items.map(async (exam) => {
        let totalPoints: number | null = null;
        let avgScore: number | null = null;
        try {
          const rubric = await examsApi.getRubricJson(exam.id);
          totalPoints = extractTotalPoints(rubric.rubric_json);
        } catch {
          totalPoints = null;
        }
        try {
          const results = await gradeApi.listResults(exam.id);
          const scores = (results.items ?? []).map((item: any) => item.total_score ?? 0);
          if (scores.length) {
            avgScore = scores.reduce((sum: number, value: number) => sum + value, 0) / scores.length;
          }
        } catch {
          avgScore = null;
        }
        return [exam.id, { totalPoints, avgScore }] as const;
      }),
    );
    setExamStats(Object.fromEntries(entries));
  };

  const loadExams = async () => {
    const data = await examsApi.list();
    const items = data.items ?? [];
    setExams(items);
    await loadExamStats(items);
  };

  useEffect(() => {
    loadExams();
  }, []);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleEditStart = (exam: { id: number; name: string }) => {
    setEditingId(exam.id);
    setEditingName(exam.name);
    setActionMessage("");
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditingName("");
  };

  const handleEditSave = async () => {
    if (!editingId || !editingName.trim()) {
      setActionMessage("시험명을 입력하세요.");
      return;
    }
    try {
      await examsApi.update(editingId, { name: editingName.trim() });
      setActionMessage("시험명이 변경되었습니다.");
      setEditingId(null);
      setEditingName("");
      await loadExams();
    } catch {
      setActionMessage("시험명 변경 실패");
    }
  };

  const handleDelete = async (examId: number) => {
    const confirmDelete = window.confirm("삭제하시겠습니까?");
    if (!confirmDelete) return;
    try {
      await examsApi.delete(examId);
      setActionMessage("시험이 삭제되었습니다.");
      if (editingId === examId) {
        handleEditCancel();
      }
      await loadExams();
    } catch {
      setActionMessage("시험 삭제 실패");
    }
  };

  const handleCreateExam = async () => {
    if (!newExamName.trim()) {
      setActionMessage("시험명을 입력하세요.");
      return;
    }
    try {
      const result = await examsApi.createEmpty({ name: newExamName.trim() });
      setNewExamName("");
      setActionMessage("시험이 등록되었습니다.");
      await loadExams();
      if (result?.exam_id) {
        setRubricEditExamId(null);
      }
    } catch {
      setActionMessage("시험 등록 실패");
    }
  };

  const handleToggleRubricEdit = (examId: number) => {
    setRubricEditExamId((prev) => (prev === examId ? null : examId));
  };

  return (
    <div className="card">
      <h2 className="text-xl font-semibold mb-4">시험 등록</h2>
      <div className="grid gap-2 mb-6">
        <label className="text-sm font-semibold">시험명 등록</label>
        <div className="flex flex-wrap gap-2">
          <input
            className="border p-2 rounded flex-1 min-w-[200px]"
            placeholder="새 시험명"
            value={newExamName}
            onChange={(e) => setNewExamName(e.target.value)}
          />
          <button
            type="button"
            className="bg-blue-600 text-white rounded px-3 py-2"
            onClick={handleCreateExam}
          >
            시험 등록
          </button>
        </div>
      </div>
      <RubricBuilder />

      <h3 className="mt-6 font-semibold">등록된 시험</h3>
      {actionMessage && <div className="mt-2 text-sm text-gray-700">{actionMessage}</div>}
      <div className="overflow-x-auto mt-2">
        <table className="min-w-full text-sm border">
          <thead className="bg-gray-100">
            <tr>
              <th className="text-left p-2 border">ID</th>
              <th className="text-left p-2 border">시험명</th>
              <th className="text-left p-2 border">등록일</th>
              <th className="text-left p-2 border">배점</th>
              <th className="text-left p-2 border">학생 평균점</th>
              <th className="text-left p-2 border">관리</th>
            </tr>
          </thead>
          <tbody>
            {exams.map((exam) => (
              <tr
                key={exam.id}
                className={`border-t ${rubricEditExamId === exam.id ? "bg-yellow-50" : ""}`}
              >
                <td className="p-2 border">{exam.id}</td>
                <td className="p-2 border">
                  {editingId === exam.id ? (
                    <input
                      className="border p-1 rounded w-full"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      ref={(element) => {
                        if (editingId === exam.id) {
                          editInputRef.current = element;
                        }
                      }}
                    />
                  ) : (
                    exam.name
                  )}
                </td>
                <td className="p-2 border">{formatDateOnly(exam.created_at)}</td>
                <td className="p-2 border">
                  {examStats[exam.id]?.totalPoints !== null && examStats[exam.id]?.totalPoints !== undefined
                    ? examStats[exam.id]?.totalPoints
                    : "-"}
                </td>
                <td className="p-2 border">
                  {examStats[exam.id]?.avgScore !== null && examStats[exam.id]?.avgScore !== undefined
                    ? examStats[exam.id]?.avgScore?.toFixed(2)
                    : "-"}
                </td>
                <td className="p-2 border">
                  {editingId === exam.id ? (
                    <div className="flex gap-2">
                      <button className="text-blue-600 underline" onClick={handleEditSave}>
                        저장
                      </button>
                      <button className="text-gray-600 underline" onClick={handleEditCancel}>
                        취소
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <button className="text-blue-600 underline" onClick={() => handleEditStart(exam)}>
                        시험명 편집
                      </button>
                      <button
                        className="text-indigo-600 underline"
                        onClick={() => handleToggleRubricEdit(exam.id)}
                      >
                        채점기준표 편집
                      </button>
                      <button className="text-red-600 underline" onClick={() => handleDelete(exam.id)}>
                        삭제
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!exams.length && (
              <tr>
                <td className="p-3 text-center text-gray-500" colSpan={6}>
                  등록된 시험이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rubricEditExamId && (
        <div className="mt-6 border-t pt-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold">채점기준표 편집 (시험 ID: {rubricEditExamId})</h4>
            <button className="text-sm text-gray-600 underline" onClick={() => setRubricEditExamId(null)}>
              닫기
            </button>
          </div>
          <RubricBuilder
            fixedExamId={rubricEditExamId}
            hideExamSelector
            onSaved={loadExams}
          />
        </div>
      )}
    </div>
  );
}
