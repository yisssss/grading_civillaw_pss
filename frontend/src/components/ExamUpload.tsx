"use client";

import { useEffect, useState } from "react";
import { examsApi } from "@/lib/api";
import RubricBuilder from "@/components/RubricBuilder";

export default function ExamUpload() {
  const [exams, setExams] = useState<any[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const loadExams = async () => {
    const data = await examsApi.list();
    setExams(data.items ?? []);
  };

  useEffect(() => {
    loadExams();
  }, []);

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
    const confirmDelete = window.confirm("해당 시험과 관련 답안/채점 결과가 모두 삭제됩니다. 진행할까요?");
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

  const handleDownloadRubric = async (examId: number) => {
    try {
      const data = await examsApi.getRubricJson(examId);
      const jsonText =
        typeof data.rubric_json === "string"
          ? data.rubric_json
          : JSON.stringify(data.rubric_json, null, 2);
      const blob = new Blob([jsonText], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `rubric_${examId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setActionMessage("파싱 결과 JSON을 다운로드했습니다.");
    } catch {
      setActionMessage("파싱 결과 다운로드 실패");
    }
  };

  return (
    <div className="card">
      <h2 className="text-xl font-semibold mb-4">시험 등록</h2>
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
              <th className="text-left p-2 border">관리</th>
            </tr>
          </thead>
          <tbody>
            {exams.map((exam) => (
              <tr key={exam.id} className="border-t">
                <td className="p-2 border">{exam.id}</td>
                <td className="p-2 border">
                  {editingId === exam.id ? (
                    <input
                      className="border p-1 rounded w-full"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                    />
                  ) : (
                    exam.name
                  )}
                </td>
                <td className="p-2 border">{exam.created_at ?? "-"}</td>
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
                        편집
                      </button>
                      <button
                        className="text-green-600 underline"
                        onClick={() => handleDownloadRubric(exam.id)}
                      >
                        파싱결과 다운로드
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
                <td className="p-3 text-center text-gray-500" colSpan={4}>
                  등록된 시험이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
