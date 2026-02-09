"use client";

import { useEffect, useMemo, useState } from "react";
import { examsApi, gradeApi } from "@/lib/api";

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function buildCsv(items: any[]) {
  const header = ["answer_id", "student_name", "student_id", "total_score", "total_max", "created_at"];
  const rows = items.map((item) => [
    item.answer_id,
    item.student_name,
    item.student_id,
    item.total_score,
    item.total_max,
    item.created_at,
  ]);
  return [header, ...rows].map((row) => row.map((cell) => `"${String(cell ?? "")}"`).join(",")).join("\n");
}

export default function StatsView() {
  const [exams, setExams] = useState<any[]>([]);
  const [selectedExam, setSelectedExam] = useState<number | null>(null);
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    examsApi.list().then((data) => setExams(data.items ?? []));
  }, []);

  useEffect(() => {
    if (!selectedExam) return;
    gradeApi.listResults(selectedExam).then((data) => setItems(data.items ?? []));
  }, [selectedExam]);

  const stats = useMemo(() => {
    if (!items.length) return null;
    const scores = items.map((item) => item.total_score ?? 0);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    return { avg, max, min };
  }, [items]);

  const handleDownloadCsv = () => {
    if (!items.length) return;
    const csv = buildCsv(items);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "grading_results.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <h2 className="text-xl font-semibold mb-4">시험별 수치</h2>
      <select
        className="border p-2 rounded"
        value={selectedExam ?? ""}
        onChange={(e) => setSelectedExam(Number(e.target.value))}
      >
        <option value="">시험 선택</option>
        {exams.map((exam) => (
          <option key={exam.id} value={exam.id}>
            {exam.name}
          </option>
        ))}
      </select>

      {stats && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="card">평균: {stats.avg.toFixed(2)}</div>
          <div className="card">최고: {stats.max.toFixed(2)}</div>
          <div className="card">최저: {stats.min.toFixed(2)}</div>
        </div>
      )}

      <div className="flex items-center justify-between mt-6">
        <h3 className="font-semibold">채점 결과 목록</h3>
        <button
          className="text-sm text-blue-600 underline disabled:text-gray-400"
          onClick={handleDownloadCsv}
          disabled={!items.length}
        >
          CSV 다운로드
        </button>
      </div>

      <div className="overflow-x-auto mt-2">
        <table className="min-w-full text-sm border">
          <thead className="bg-gray-100">
            <tr>
              <th className="text-left p-2 border">답안 ID</th>
              <th className="text-left p-2 border">학생</th>
              <th className="text-left p-2 border">점수</th>
              <th className="text-left p-2 border">등록일</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.answer_id} className="border-t">
                <td className="p-2 border">{item.answer_id}</td>
                <td className="p-2 border">
                  {item.student_name} ({item.student_id})
                </td>
                <td className="p-2 border">
                  {item.total_score} / {item.total_max}
                </td>
                <td className="p-2 border">{formatDate(item.created_at)}</td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td className="p-3 text-center text-gray-500" colSpan={4}>
                  결과가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
