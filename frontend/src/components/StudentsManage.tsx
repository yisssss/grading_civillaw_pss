"use client";

import { useEffect, useMemo, useState } from "react";
import { gradeApi, studentsApi } from "@/lib/api";

type Student = {
  id: number;
  student_id: string;
  name: string;
  created_at?: string;
};

type ResultItem = {
  answer_id: number;
  exam_id: number;
  exam_name: string;
  student_id: number;
  student_name: string;
  total_score: number;
  total_max: number;
  created_at?: string;
};

type SortKey = "name" | "student_id";

export default function StudentsManage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingStudentId, setEditingStudentId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [actionMessage, setActionMessage] = useState("");
  const [studentId, setStudentId] = useState("");
  const [studentName, setStudentName] = useState("");
  const [studentMessage, setStudentMessage] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvMessage, setCsvMessage] = useState("");

  const parseCsvStudents = (text: string) => {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return { items: [] as { student_id: string; name: string }[], errors: [] as string[] };

    const rows = lines.map((line) => line.split(",").map((cell) => cell.trim()));
    const header = rows[0].map((cell) => cell.toLowerCase());
    const hasHeader =
      header.includes("student_id") ||
      header.includes("name") ||
      header.includes("학번") ||
      header.includes("이름");

    const items: { student_id: string; name: string }[] = [];
    const errors: string[] = [];
    const startIndex = hasHeader ? 1 : 0;

    for (let i = startIndex; i < rows.length; i += 1) {
      const [student_id, name] = rows[i];
      if (!student_id || !name) {
        errors.push(`줄 ${i + 1}: 학번/이름 누락`);
        continue;
      }
      items.push({ student_id, name });
    }
    return { items, errors };
  };

  const loadStudents = async () => {
    const data = await studentsApi.list();
    setStudents(data.items ?? []);
  };

  useEffect(() => {
    loadStudents();
  }, []);

  useEffect(() => {
    if (!selectedStudentId) {
      setResults([]);
      return;
    }
    gradeApi.listResults(undefined, selectedStudentId).then((data) => {
      setResults(data.items ?? []);
    });
  }, [selectedStudentId]);

  const formatDateOnly = (value?: string) => {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const sortedStudents = useMemo(() => {
    const copy = [...students];
    copy.sort((a, b) => {
      if (sortKey === "student_id") {
        return a.student_id.localeCompare(b.student_id);
      }
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [students, sortKey]);

  const handleEditStart = (student: Student) => {
    setEditingId(student.id);
    setEditingStudentId(student.student_id);
    setEditingName(student.name);
    setActionMessage("");
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditingStudentId("");
    setEditingName("");
  };

  const handleEditSave = async () => {
    if (!editingId || !editingStudentId.trim() || !editingName.trim()) {
      setActionMessage("학번과 이름을 입력하세요.");
      return;
    }
    try {
      await studentsApi.update(editingId, {
        student_id: editingStudentId.trim(),
        name: editingName.trim(),
      });
      setActionMessage("학생 정보가 변경되었습니다.");
      handleEditCancel();
      await loadStudents();
    } catch {
      setActionMessage("학생 정보 변경 실패");
    }
  };

  const handleCreateStudent = async () => {
    if (!studentId || !studentName) {
      setStudentMessage("학번과 이름을 입력하세요.");
      return;
    }
    try {
      await studentsApi.create({ student_id: studentId, name: studentName });
      setStudentMessage("학생 등록 완료");
      setStudentId("");
      setStudentName("");
      await loadStudents();
    } catch {
      setStudentMessage("학생 등록 실패 (중복 여부 확인)");
    }
  };

  const handleCsvUpload = async () => {
    if (!csvFile) {
      setCsvMessage("CSV 파일을 선택하세요.");
      return;
    }
    const text = await csvFile.text();
    const { items, errors } = parseCsvStudents(text);
    if (!items.length) {
      setCsvMessage("등록할 학생 데이터가 없습니다.");
      return;
    }
    let success = 0;
    const failed: string[] = [...errors];
    for (const item of items) {
      try {
        await studentsApi.create(item);
        success += 1;
      } catch {
        failed.push(`${item.student_id}/${item.name}: 실패`);
      }
    }
    await loadStudents();
    setCsvMessage(`성공 ${success}명, 실패 ${failed.length}건${failed.length ? `: ${failed.join(", ")}` : ""}`);
    setCsvFile(null);
  };

  const handleDelete = async (studentId: number) => {
    if (!confirm("삭제하시겠습니까?")) return;
    try {
      await studentsApi.delete(studentId);
      if (selectedStudentId === studentId) {
        setSelectedStudentId(null);
      }
      await loadStudents();
    } catch {
      setActionMessage("학생 삭제 실패");
    }
  };

  const averageScore = useMemo(() => {
    if (!results.length) return null;
    const total = results.reduce((sum, item) => sum + (item.total_score ?? 0), 0);
    return total / results.length;
  }, [results]);

  return (
    <div className="card">
      <h2 className="text-xl font-semibold mb-4">학생 관리</h2>
      {actionMessage && <div className="mb-2 text-sm text-gray-700">{actionMessage}</div>}

      <div className="card mb-4">
        <h3 className="font-semibold mb-2">학생 등록</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="border p-2 rounded"
            placeholder="학번"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
          />
          <input
            className="border p-2 rounded"
            placeholder="이름"
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
          />
        </div>
        <button className="bg-gray-900 text-white rounded px-4 py-2 mt-3" onClick={handleCreateStudent}>
          학생 등록
        </button>
        {studentMessage && <div className="mt-2 text-sm text-gray-700">{studentMessage}</div>}

        <div className="mt-6 border-t pt-4">
          <h3 className="font-semibold mb-2">CSV 대량 등록</h3>
          <div className="grid gap-2 md:grid-cols-3">
            <input
              type="file"
              accept=".csv"
              onChange={(e) => {
                setCsvFile(e.target.files?.[0] ?? null);
                setCsvMessage("");
              }}
            />
            <button className="bg-blue-600 text-white rounded px-4 py-2" onClick={handleCsvUpload}>
              CSV 업로드
            </button>
            <div className="text-sm text-gray-600">형식: 학번,이름 (첫 줄 헤더 가능)</div>
          </div>
          {csvMessage && <div className="mt-2 text-sm text-gray-700">{csvMessage}</div>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          className={`px-3 py-1 rounded border ${sortKey === "name" ? "bg-blue-600 text-white" : "bg-gray-100"}`}
          onClick={() => setSortKey("name")}
        >
          가나다순
        </button>
        <button
          className={`px-3 py-1 rounded border ${sortKey === "student_id" ? "bg-blue-600 text-white" : "bg-gray-100"}`}
          onClick={() => setSortKey("student_id")}
        >
          학번순
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-[2fr_1.2fr]">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border">
            <thead className="bg-gray-100">
              <tr>
                <th className="text-left p-2 border">학번</th>
                <th className="text-left p-2 border">이름</th>
                <th className="text-left p-2 border">관리</th>
              </tr>
            </thead>
            <tbody>
              {sortedStudents.map((student) => (
                <tr
                  key={student.id}
                  className={`border-t ${selectedStudentId === student.id ? "bg-yellow-50" : ""}`}
                  onClick={() => setSelectedStudentId(student.id)}
                >
                  <td className="p-2 border">
                    {editingId === student.id ? (
                      <input
                        className="border p-1 rounded w-full"
                        value={editingStudentId}
                        onChange={(e) => setEditingStudentId(e.target.value)}
                      />
                    ) : (
                      student.student_id
                    )}
                  </td>
                  <td className="p-2 border">
                    {editingId === student.id ? (
                      <input
                        className="border p-1 rounded w-full"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                      />
                    ) : (
                      student.name
                    )}
                  </td>
                  <td className="p-2 border" onClick={(e) => e.stopPropagation()}>
                    {editingId === student.id ? (
                      <div className="flex gap-2">
                        <button className="text-blue-600 underline" onClick={handleEditSave}>
                          저장
                        </button>
                        <button className="text-gray-600 underline" onClick={handleEditCancel}>
                          취소
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button className="text-blue-600 underline" onClick={() => handleEditStart(student)}>
                          편집
                        </button>
                        <button className="text-red-600 underline" onClick={() => handleDelete(student.id)}>
                          삭제
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {!sortedStudents.length && (
                <tr>
                  <td className="p-3 text-center text-gray-500" colSpan={3}>
                    등록된 학생이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="border rounded p-3 bg-gray-50">
          <h3 className="font-semibold mb-2">학생 상세</h3>
          {!selectedStudentId && <div className="text-sm text-gray-500">학생을 선택하세요.</div>}
          {selectedStudentId && (
            <>
              <div className="text-sm text-gray-600 mb-2">
                평균 점수: {averageScore !== null ? averageScore.toFixed(2) : "-"}
              </div>
              <div className="overflow-y-auto max-h-64">
                <table className="min-w-full text-sm border">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="text-left p-2 border">시험</th>
                      <th className="text-left p-2 border">점수</th>
                      <th className="text-left p-2 border">등록일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((item) => (
                      <tr key={item.answer_id} className="border-t">
                        <td className="p-2 border">{item.exam_name}</td>
                        <td className="p-2 border">
                          {item.total_score} / {item.total_max}
                        </td>
                        <td className="p-2 border">{formatDateOnly(item.created_at)}</td>
                      </tr>
                    ))}
                    {!results.length && (
                      <tr>
                        <td className="p-3 text-center text-gray-500" colSpan={3}>
                          응시 기록이 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
