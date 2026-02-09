"use client";

import { useEffect, useRef, useState } from "react";
import { examsApi, rubricApi, RubricCreatePayload } from "@/lib/api";

type SectionNode = {
  _id: string;
  label: string;
  title: string;
  points: number | "";
  content: string;
  sub_sections: SectionNode[];
};

type ProblemNode = {
  id: string;
  total_points: number | "";
  sections: SectionNode[];
};

type ContextState = {
  fact_pattern: string;
  question: string;
};

const ROMAN_LABELS = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ"];
const KOREAN_LABELS = [
  "가",
  "나",
  "다",
  "라",
  "마",
  "바",
  "사",
  "아",
  "자",
  "차",
  "카",
  "타",
  "파",
  "하",
];

const getNextLabel = (depth: number, siblings: SectionNode[]) => {
  if (depth === 0) {
    const indices = siblings
      .map((s) => ROMAN_LABELS.indexOf(s.label))
      .filter((idx) => idx >= 0);
    const nextIndex = indices.length ? Math.max(...indices) + 1 : 0;
    return ROMAN_LABELS[nextIndex] ?? `${siblings.length + 1}`;
  }
  if (depth === 1) {
    const numbers = siblings
      .map((s) => parseInt(s.label, 10))
      .filter((n) => Number.isFinite(n));
    const nextNumber = numbers.length ? Math.max(...numbers) + 1 : 1;
    return `${nextNumber}`;
  }
  const indices = siblings
    .map((s) => KOREAN_LABELS.indexOf(s.label))
    .filter((idx) => idx >= 0);
  const nextIndex = indices.length ? Math.max(...indices) + 1 : 0;
  return KOREAN_LABELS[nextIndex] ?? `${siblings.length + 1}`;
};

const renderUnderlinedPreview = (text: string) => {
  if (!text) return null;
  const parts = text.split(/(__[^_]+__)/g).filter((part) => part !== "");
  return parts.map((part, index) => {
    if (part.startsWith("__") && part.endsWith("__") && part.length > 4) {
      const inner = part.slice(2, -2);
      return (
        <span key={`${index}-${inner}`} className="underline decoration-2 text-blue-700">
          {inner}
        </span>
      );
    }
    return <span key={`${index}-${part}`}>{part}</span>;
  });
};

const toNumber = (value: number | "") => {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sumSectionPoints = (section: SectionNode): number => {
  if (section.sub_sections.length > 0) {
    return section.sub_sections.reduce((sum, child) => sum + sumSectionPoints(child), 0);
  }
  return toNumber(section.points) ?? 0;
};

const sumProblemPoints = (problem: ProblemNode): number =>
  problem.sections.reduce((sum, section) => sum + sumSectionPoints(section), 0);

export default function RubricBuilder() {
  const idRef = useRef(0);
  const [contexts, setContexts] = useState<ContextState[]>([
    { fact_pattern: "", question: "" },
    { fact_pattern: "", question: "" },
    { fact_pattern: "", question: "" },
  ]);
  const [exams, setExams] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedExamId, setSelectedExamId] = useState<number | null>(null);
  const [newExamName, setNewExamName] = useState("");
  const [savedRubricJson, setSavedRubricJson] = useState<string>("");
  const [problems, setProblems] = useState<ProblemNode[]>([
    { id: "1", total_points: "", sections: [] },
  ]);
  const [sendNullForEmptySubsections, setSendNullForEmptySubsections] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const loadExams = async () => {
    const data = await examsApi.list();
    const items = (data.items ?? []).map((item: { id: number; name: string }) => ({
      id: item.id,
      name: item.name,
    }));
    setExams(items);
    if (items.length > 0 && selectedExamId === null) {
      setSelectedExamId(items[0].id);
    }
  };

  useEffect(() => {
    loadExams();
  }, []);

  useEffect(() => {
    const loadRubricJson = async () => {
      if (!selectedExamId) {
        setSavedRubricJson("");
        return;
      }
      try {
        const data = await examsApi.getRubricJson(selectedExamId);
        const jsonText =
          typeof data.rubric_json === "string"
            ? data.rubric_json
            : JSON.stringify(data.rubric_json, null, 2);
        setSavedRubricJson(jsonText);
      } catch {
        setSavedRubricJson("");
      }
    };
    loadRubricJson();
  }, [selectedExamId]);

  const nextId = () => {
    idRef.current += 1;
    return `section-${idRef.current}`;
  };

  const createSection = (depth: number, siblings: SectionNode[]): SectionNode => ({
    _id: nextId(),
    label: getNextLabel(depth, siblings),
    title: "",
    points: "",
    content: "",
    sub_sections: [],
  });

  const updateSectionById = (
    sections: SectionNode[],
    targetId: string,
    updater: (section: SectionNode) => SectionNode,
  ): SectionNode[] =>
    sections.map((section) => {
      if (section._id === targetId) {
        return updater(section);
      }
      return {
        ...section,
        sub_sections: updateSectionById(section.sub_sections, targetId, updater),
      };
    });

  const removeSectionById = (sections: SectionNode[], targetId: string): SectionNode[] =>
    sections
      .filter((section) => section._id !== targetId)
      .map((section) => ({
        ...section,
        sub_sections: removeSectionById(section.sub_sections, targetId),
      }));

  const handleAddProblem = () => {
    setProblems((prev) => [
      ...prev,
      { id: `${prev.length + 1}`, total_points: "", sections: [] },
    ]);
  };

  const handleRemoveProblem = (index: number) => {
    setProblems((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleAddSection = (problemIndex: number) => {
    setProblems((prev) =>
      prev.map((problem, idx) =>
        idx === problemIndex
          ? {
              ...problem,
              sections: [...problem.sections, createSection(0, problem.sections)],
            }
          : problem,
      ),
    );
  };

  const handleAddSubSection = (problemIndex: number, parentId: string, depth: number) => {
    setProblems((prev) =>
      prev.map((problem, idx) => {
        if (idx !== problemIndex) return problem;
        return {
          ...problem,
          sections: updateSectionById(problem.sections, parentId, (section) => ({
            ...section,
            sub_sections: [...section.sub_sections, createSection(depth + 1, section.sub_sections)],
          })),
        };
      }),
    );
  };

  const handleUpdateSection = (
    problemIndex: number,
    sectionId: string,
    updater: (section: SectionNode) => SectionNode,
  ) => {
    setProblems((prev) =>
      prev.map((problem, idx) =>
        idx === problemIndex
          ? { ...problem, sections: updateSectionById(problem.sections, sectionId, updater) }
          : problem,
      ),
    );
  };

  const handleRemoveSection = (problemIndex: number, sectionId: string) => {
    setProblems((prev) =>
      prev.map((problem, idx) =>
        idx === problemIndex
          ? { ...problem, sections: removeSectionById(problem.sections, sectionId) }
          : problem,
      ),
    );
  };

  const buildPayload = (): RubricCreatePayload => {
    const normalizeSection = (
      section: SectionNode,
    ): RubricCreatePayload["problems"][0]["sections"][0] => {
      const normalizedChildren = section.sub_sections.map(normalizeSection);
      const hasChildren = normalizedChildren.length > 0;
      return {
        label: section.label.trim(),
        title: section.title.trim(),
        points: toNumber(section.points),
        content: section.content.trim(),
        sub_sections: hasChildren ? normalizedChildren : sendNullForEmptySubsections ? null : [],
      };
    };

    return {
      exam_id: selectedExamId ?? 0,
      context: contexts.map((item) => ({
        fact_pattern: item.fact_pattern.trim(),
        question: item.question.trim(),
      })),
      problems: problems.map((problem) => ({
        id: problem.id.trim(),
        total_points: toNumber(problem.total_points),
        sections: problem.sections.map(normalizeSection),
      })),
    };
  };

  const handleSave = async () => {
    setActionMessage("");
    setIsSaving(true);
    try {
      if (!selectedExamId) {
        setActionMessage("시험을 선택하세요.");
        return;
      }
      const payload = buildPayload();
      const result = await rubricApi.create(payload);
      setActionMessage(`저장 완료: ${JSON.stringify(result)}`);
    } catch {
      setActionMessage("저장 실패: 서버 요청을 확인하세요.");
    } finally {
      setIsSaving(false);
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
        setSelectedExamId(result.exam_id);
      }
    } catch {
      setActionMessage("시험 등록 실패");
    }
  };

  const renderSection = (
    section: SectionNode,
    problemIndex: number,
    depth: number,
    siblings: SectionNode[],
  ) => {
    const childSum = section.sub_sections.reduce((sum, child) => sum + sumSectionPoints(child), 0);
    const points = toNumber(section.points);
    const isOver = points !== null && childSum > points;
    const nextSuggestion = getNextLabel(depth, siblings);

    return (
      <div key={section._id} className="border rounded p-3 mb-3" style={{ marginLeft: depth * 16 }}>
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="border p-2 rounded w-24"
              placeholder="라벨"
              value={section.label}
              onChange={(e) =>
                handleUpdateSection(problemIndex, section._id, (current) => ({
                  ...current,
                  label: e.target.value,
                }))
              }
            />
            <button
              type="button"
              className="text-xs text-blue-700 underline"
              onClick={() =>
                handleUpdateSection(problemIndex, section._id, (current) => ({
                  ...current,
                  label: nextSuggestion,
                }))
              }
            >
              추천 라벨: {nextSuggestion}
            </button>
            <input
              className="border p-2 rounded flex-1"
              placeholder="제목"
              value={section.title}
              onChange={(e) =>
                handleUpdateSection(problemIndex, section._id, (current) => ({
                  ...current,
                  title: e.target.value,
                }))
              }
            />
            <input
              className="border p-2 rounded w-28"
              type="number"
              step="0.5"
              placeholder="배점"
              value={section.points}
              onChange={(e) =>
                handleUpdateSection(problemIndex, section._id, (current) => ({
                  ...current,
                  points: e.target.value === "" ? "" : Number(e.target.value),
                }))
              }
            />
          </div>
          <textarea
            className="border p-2 rounded min-h-[80px]"
            placeholder="채점 기준 내용"
            value={section.content}
            onChange={(e) =>
              handleUpdateSection(problemIndex, section._id, (current) => ({
                ...current,
                content: e.target.value,
              }))
            }
          />
          <div className="text-xs text-gray-600">미리보기</div>
          <div className="border rounded p-2 bg-gray-50 text-sm whitespace-pre-wrap">
            {renderUnderlinedPreview(section.content)}
          </div>
          {section.sub_sections.length > 0 && (
            <div className={`text-sm ${isOver ? "text-red-600" : "text-gray-600"}`}>
              하위 항목 합계: {childSum} / 배점: {points ?? "-"}
              {isOver && " (배점 초과)"}
            </div>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              className="text-blue-600 underline"
              onClick={() => handleAddSubSection(problemIndex, section._id, depth)}
            >
              하위 항목 추가
            </button>
            <button
              type="button"
              className="text-red-600 underline"
              onClick={() => handleRemoveSection(problemIndex, section._id)}
            >
              삭제
            </button>
          </div>
        </div>
        {section.sub_sections.map((child) =>
          renderSection(child, problemIndex, depth + 1, section.sub_sections),
        )}
      </div>
    );
  };

  return (
    <div className="card">
      <h2 className="text-xl font-semibold mb-4">Rubric Builder</h2>

      <div className="grid gap-2 mb-4">
        <label className="text-sm font-semibold">등록할 시험 선택</label>
        {exams.length > 0 ? (
          <select
            className="border p-2 rounded"
            value={selectedExamId ?? ""}
            onChange={(e) => setSelectedExamId(Number(e.target.value))}
          >
            {exams.map((exam) => (
              <option key={exam.id} value={exam.id}>
                {exam.name} (ID: {exam.id})
              </option>
            ))}
          </select>
        ) : (
          <div className="text-sm text-gray-600">등록된 시험이 없습니다.</div>
        )}
      </div>

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

      <div className="grid gap-3 mb-6">
        <h3 className="font-semibold">사실관계/문제</h3>
        {contexts.map((item, index) => (
          <div key={`context-${index}`} className="grid gap-2 border rounded p-3">
            <div className="text-sm font-semibold">사실관계/문제 {index + 1}</div>
            <textarea
              className="border p-2 rounded min-h-[90px]"
              placeholder="사실관계 텍스트"
              value={item.fact_pattern}
              onChange={(e) =>
                setContexts((prev) =>
                  prev.map((ctx, idx) =>
                    idx === index ? { ...ctx, fact_pattern: e.target.value } : ctx,
                  ),
                )
              }
            />
            <textarea
              className="border p-2 rounded min-h-[90px]"
              placeholder="문제 텍스트"
              value={item.question}
              onChange={(e) =>
                setContexts((prev) =>
                  prev.map((ctx, idx) => (idx === index ? { ...ctx, question: e.target.value } : ctx)),
                )
              }
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <input
          id="send-null"
          type="checkbox"
          checked={sendNullForEmptySubsections}
          onChange={(e) => setSendNullForEmptySubsections(e.target.checked)}
        />
        <label htmlFor="send-null" className="text-sm text-gray-700">
          하위 항목이 없을 때 null로 전송
        </label>
      </div>

      <div className="grid gap-6">
        {problems.map((problem, index) => {
          const total = toNumber(problem.total_points);
          const sum = sumProblemPoints(problem);
          const isMismatch = total !== null && sum !== total;
          const isOver = total !== null && sum > total;

          return (
            <div key={`${problem.id}-${index}`} className="border rounded p-4">
              <div className="flex flex-wrap gap-3 items-center mb-3">
                <input
                  className="border p-2 rounded w-24"
                  placeholder="문제 ID"
                  value={problem.id}
                  onChange={(e) =>
                    setProblems((prev) =>
                      prev.map((item, idx) =>
                        idx === index ? { ...item, id: e.target.value } : item,
                      ),
                    )
                  }
                />
                <input
                  className="border p-2 rounded w-32"
                  type="number"
                  step="0.5"
                  placeholder="총점"
                  value={problem.total_points}
                  onChange={(e) =>
                    setProblems((prev) =>
                      prev.map((item, idx) =>
                        idx === index
                          ? {
                              ...item,
                              total_points: e.target.value === "" ? "" : Number(e.target.value),
                            }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="text-blue-600 underline"
                  onClick={() => handleAddSection(index)}
                >
                  섹션(Ⅰ) 추가
                </button>
                <button
                  type="button"
                  className="text-red-600 underline"
                  onClick={() => handleRemoveProblem(index)}
                >
                  문제 삭제
                </button>
              </div>
              <div className={`text-sm ${isOver ? "text-red-600" : "text-gray-600"}`}>
                현재 합계: {sum} / 총점: {total ?? "-"}
                {isMismatch && !isOver && " (합계 불일치)"}
                {isOver && " (배점 초과)"}
              </div>
              <div className="mt-4">
                {problem.sections.map((section) => renderSection(section, index, 0, problem.sections))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          className="bg-gray-100 border rounded px-3 py-2"
          onClick={handleAddProblem}
        >
          문제 추가
        </button>
        <button
          type="button"
          className="bg-blue-600 text-white rounded px-3 py-2"
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? "저장 중..." : "저장"}
        </button>
      </div>

      {actionMessage && <div className="mt-3 text-sm text-gray-700">{actionMessage}</div>}

      {savedRubricJson && (
        <div className="mt-6">
          <h3 className="font-semibold mb-2">저장된 채점 기준표 (읽기 전용)</h3>
          <pre className="border rounded p-3 bg-gray-50 text-sm whitespace-pre-wrap">
            {savedRubricJson}
          </pre>
        </div>
      )}
    </div>
  );
}
