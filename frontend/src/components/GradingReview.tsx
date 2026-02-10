"use client";

import { useEffect, useMemo, useState } from "react";
import { answersApi, examsApi, gradeApi, studentsApi } from "@/lib/api";

type ScoreDetail = {
  section_id: string;
  title: string;
  max_points: number;
  score: number;
  deductions?: { reason: string; penalty: number }[];
  is_leaf?: boolean;
  llm?: { note?: string };
};

type Student = {
  id: number;
  student_id: string;
  name: string;
};

type Exam = {
  id: number;
  name: string;
};

type AnswerItem = {
  id: number;
  exam_id: number;
  student_id: number;
  created_at?: string;
};

type ResultPayload = {
  score_details?: ScoreDetail[];
  [key: string]: any;
};

type EditDeduction = { reason: string; penalty: string };
type AnswerSortKey = "name" | "student_id" | "score_desc";
type ExportScope = "all" | "selected";
type ExportFormat = "html" | "pdf";
type ExportMode = "single" | "batch";

function splitByProblemHeadings(text: string) {
  const chunks: Record<string, string> = {};
  const order: string[] = [];
  const lines = text.split(/\r?\n/);
  const headingRegex = /^\s*(?:\[)?(?:문제|문|설문)\s*(\d+)\s*[\]\.\):]?\s*(.*)$/;
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!current) {
      buffer = [];
      return;
    }
    const content = buffer.join("\n").trim();
    if (content) {
      chunks[current] = content;
    }
    buffer = [];
  };

  for (const line of lines) {
    const match = line.trim().match(headingRegex);
    if (match) {
      flush();
      current = match[1];
      if (!order.includes(current)) {
        order.push(current);
      }
      buffer = [line];
      const trailing = match[2].trim();
      if (trailing) {
        buffer.push(trailing);
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return { chunks, order };
}

function formatDateOnly(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAnswerForDisplay(text: string) {
  if (!text) return "";
  const headingRegex =
    /^\s*(?!제\d+(조|항|호)\b)(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}\.|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}(?=\s|$)|\d+\.|\(\d+\)|\([가나다라마바사아자차카타파하]\))/;
  const inlineBreakRegex =
    /(\s)(?!(?:제)\d+(조|항|호)\b)([ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}\.|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}(?=\s)|\d+\.|\(\d+\)|\([가나다라마바사아자차카타파하]\))/g;

  const withInlineBreaks = text.replace(inlineBreakRegex, "\n$3");
  const lines = withInlineBreaks.split(/\r?\n/);
  const formatted: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && headingRegex.test(trimmed)) {
      if (formatted.length && formatted[formatted.length - 1].trim() !== "") {
        formatted.push("");
      }
    }
    formatted.push(line);
  }
  return formatted.join("\n");
}

function detectHeadingLevel(line: string) {
  const trimmed = line.trim();
  if (!trimmed || /^\s*제\d+(조|항|호)\b/.test(trimmed)) return null;
  if (/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}\./.test(trimmed) || /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}\b/.test(trimmed)) {
    return 1;
  }
  if (/^\d+\./.test(trimmed)) {
    return 2;
  }
  if (/^\(\d+\)/.test(trimmed) || /^\([가나다라마바사아자차카타파하]\)/.test(trimmed)) {
    return 3;
  }
  return null;
}

export default function GradingReview() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [answers, setAnswers] = useState<AnswerItem[]>([]);
  const [resultsMap, setResultsMap] = useState<Record<number, { total_score: number; total_max: number }>>({});
  const [selectedExam, setSelectedExam] = useState<number | null>(null);
  const [selectedStudentFilter, setSelectedStudentFilter] = useState<number | null>(null);
  const [selectedAnswerId, setSelectedAnswerId] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [scoreDetails, setScoreDetails] = useState<ScoreDetail[]>([]);
  const [resultPayload, setResultPayload] = useState<ResultPayload | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [editScore, setEditScore] = useState<string>("");
  const [editDeductions, setEditDeductions] = useState<EditDeduction[]>([]);
  const [editNote, setEditNote] = useState<string>("");
  const [actionMessage, setActionMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [selectedProblemTab, setSelectedProblemTab] = useState("1");
  const [answerFontSize, setAnswerFontSize] = useState(14);
  const [studentSearch, setStudentSearch] = useState("");
  const [answerSortKey, setAnswerSortKey] = useState<AnswerSortKey>("name");
  const [exportMessage, setExportMessage] = useState("");
  const [selectedAnswerIds, setSelectedAnswerIds] = useState<Set<number>>(new Set());
  const [exportScope, setExportScope] = useState<ExportScope>("all");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("html");
  const [exportMode, setExportMode] = useState<ExportMode>("single");

  const loadData = async () => {
    const examsData = await examsApi.list();
    setExams(examsData.items ?? []);
    const studentsData = await studentsApi.list();
    setStudents(studentsData.items ?? []);
  };

  const loadAnswers = async (examId: number, studentIdFilter?: number | null) => {
    const answersData = await answersApi.list(examId, studentIdFilter ?? undefined);
    setAnswers(answersData.items ?? []);
    const resultsData = await gradeApi.listResults(examId, studentIdFilter ?? undefined);
    const map: Record<number, { total_score: number; total_max: number }> = {};
    (resultsData.items ?? []).forEach((item: any) => {
      map[item.answer_id] = { total_score: item.total_score ?? 0, total_max: item.total_max ?? 0 };
    });
    setResultsMap(map);
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!selectedExam) {
      setAnswers([]);
      setResultsMap({});
      return;
    }
    loadAnswers(selectedExam, selectedStudentFilter);
  }, [selectedExam, selectedStudentFilter]);

  const studentsById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);

  const filteredAnswers = useMemo(() => {
    const keyword = studentSearch.trim().toLowerCase().replace(/\s+/g, "");
    if (!keyword) return answers;
    return answers.filter((answer) => {
      const student = studentsById.get(answer.student_id);
      const haystack = `${student?.student_id ?? ""}${student?.name ?? ""}`
        .toLowerCase()
        .replace(/\s+/g, "");
      return haystack.includes(keyword);
    });
  }, [answers, studentsById, studentSearch]);

  const sortedAnswers = useMemo(() => {
    const list = [...filteredAnswers];
    list.sort((a, b) => {
      const studentA = studentsById.get(a.student_id);
      const studentB = studentsById.get(b.student_id);
      if (answerSortKey === "student_id") {
        return (studentA?.student_id ?? "").localeCompare(studentB?.student_id ?? "");
      }
      if (answerSortKey === "score_desc") {
        const scoreA = resultsMap[a.id]?.total_score ?? 0;
        const scoreB = resultsMap[b.id]?.total_score ?? 0;
        return scoreB - scoreA;
      }
      return (studentA?.name ?? "").localeCompare(studentB?.name ?? "");
    });
    return list;
  }, [filteredAnswers, answerSortKey, resultsMap, studentsById]);

  useEffect(() => {
    if (!answers.length) {
      setSelectedAnswerIds(new Set());
      return;
    }
    setSelectedAnswerIds((prev) => {
      const next = new Set<number>();
      answers.forEach((answer) => {
        if (prev.has(answer.id)) next.add(answer.id);
      });
      return next;
    });
  }, [answers]);

  const toggleSelected = (answerId: number) => {
    setSelectedAnswerIds((prev) => {
      const next = new Set(prev);
      if (next.has(answerId)) {
        next.delete(answerId);
      } else {
        next.add(answerId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (sortedAnswers.length === selectedAnswerIds.size) {
      setSelectedAnswerIds(new Set());
      return;
    }
    setSelectedAnswerIds(new Set(sortedAnswers.map((answer) => answer.id)));
  };

  const loadAnswerDetail = async (answerId: number) => {
    setSelectedAnswerId(answerId);
    setActionMessage("");
    const answer = await answersApi.get(answerId);
    const result = await gradeApi.getResult(answerId);
    setAnswerText(answer.answer_text || "");
    setScoreDetails(result.score_details || []);
    setResultPayload(result);
    setActiveSectionId(null);
    setEditScore("");
    setEditDeductions([]);
    setEditNote("");
    setSelectedProblemTab("1");
  };

  const scoreTreeByProblem = useMemo(() => {
    const byProblem: Record<
      string,
      { order: string[]; roots: string[]; nodes: Record<string, ScoreDetail & { children: string[] }> }
    > = {};

    scoreDetails.forEach((detail) => {
      const problemId = detail.section_id.split(".")[0];
      if (!byProblem[problemId]) {
        byProblem[problemId] = { order: [], roots: [], nodes: {} };
      }
      if (!byProblem[problemId].nodes[detail.section_id]) {
        byProblem[problemId].nodes[detail.section_id] = { ...detail, children: [] };
        byProblem[problemId].order.push(detail.section_id);
      }
    });

    Object.entries(byProblem).forEach(([problemId, data]) => {
      data.order.forEach((sectionId) => {
        const parts = sectionId.split(".");
        const parentId = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
        if (parentId && data.nodes[parentId]) {
          data.nodes[parentId].children.push(sectionId);
        } else {
          data.roots.push(sectionId);
        }
      });
    });

    return byProblem;
  }, [scoreDetails]);

  const childScoreMap = useMemo(() => {
    const map: Record<string, { sum: number; max: number }> = {};
    scoreDetails.forEach((detail) => {
      if (detail.is_leaf) {
        const parts = detail.section_id.split(".");
        for (let i = 1; i < parts.length; i += 1) {
          const parentId = parts.slice(0, i).join(".");
          if (!map[parentId]) {
            map[parentId] = { sum: 0, max: 0 };
          }
          map[parentId].sum += detail.score ?? 0;
          map[parentId].max += detail.max_points ?? 0;
        }
      }
    });
    return map;
  }, [scoreDetails]);

  const problemTotals = useMemo(() => {
    const totals: Record<string, { score: number; max: number }> = {};
    scoreDetails.forEach((detail) => {
      if (!detail.is_leaf) return;
      const problemId = detail.section_id.split(".")[0];
      if (!totals[problemId]) {
        totals[problemId] = { score: 0, max: 0 };
      }
      totals[problemId].score += detail.score ?? 0;
      totals[problemId].max += detail.max_points ?? 0;
    });
    return totals;
  }, [scoreDetails]);

  const handleSelectDetail = (detail: ScoreDetail) => {
    setActiveSectionId(detail.section_id);
    setEditScore(detail.score?.toString() ?? "");
    const deductions = (detail.deductions ?? []).map((d) => ({
      reason: d.reason ?? "",
      penalty: d.penalty?.toString() ?? "",
    }));
    setEditDeductions(deductions.length ? deductions : []);
    setEditNote(detail.llm?.note ?? "");
  };

  const applyEditToDetails = () => {
    if (!activeSectionId) return scoreDetails;
    const nextScore = editScore === "" ? 0 : Number(editScore);
    const deductions = editDeductions
      .filter((d) => d.reason.trim() || d.penalty.trim())
      .map((d) => ({
        reason: d.reason.trim(),
        penalty: d.penalty === "" ? 0 : Number(d.penalty),
      }));
    return scoreDetails.map((detail) =>
      detail.section_id === activeSectionId
        ? {
            ...detail,
            score: Number.isFinite(nextScore) ? nextScore : detail.score,
            deductions,
            llm: { ...(detail.llm ?? {}), note: editNote.trim() },
          }
        : detail
    );
  };

  const handleSave = async () => {
    if (!selectedAnswerId || !resultPayload) return;
    setIsSaving(true);
    setActionMessage("");
    try {
      const updatedScoreDetails = applyEditToDetails();
      const payload = { ...resultPayload, score_details: updatedScoreDetails };
      await gradeApi.updateResult(selectedAnswerId, payload);
      setScoreDetails(updatedScoreDetails);
      setResultPayload(payload);
      if (selectedExam != null) await loadAnswers(selectedExam, selectedStudentFilter);
      setActionMessage("채점 내역이 저장되었습니다.");
    } catch {
      setActionMessage("저장 실패: 서버 요청을 확인하세요.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddDeduction = () => {
    setEditDeductions((prev) => [...prev, { reason: "", penalty: "" }]);
  };

  const handleRemoveDeduction = (index: number) => {
    setEditDeductions((prev) => prev.filter((_, idx) => idx !== index));
  };

  const formattedAnswer = useMemo(() => formatAnswerForDisplay(answerText || ""), [answerText]);
  const { chunks: problemChunks, order: problemOrder } = useMemo(
    () => splitByProblemHeadings(formattedAnswer),
    [formattedAnswer]
  );

  const buildExportItems = async (list: AnswerItem[]) => {
    const exportItems: Array<{
      answerId: number;
      studentName: string;
      studentId: string;
      createdAt?: string;
      totalScore?: number;
      totalMax?: number;
      answerText: string;
      scoreDetails: ScoreDetail[];
    }> = [];

    for (const answer of list) {
      const student = studentsById.get(answer.student_id);
      try {
        const [answerDetail, result] = await Promise.all([
          answersApi.get(answer.id),
          gradeApi.getResult(answer.id),
        ]);
        const scoreDetails: ScoreDetail[] = result.score_details || [];
        const leafDetails = scoreDetails.filter((d) => d.is_leaf);
        const totalsBase = leafDetails.length ? leafDetails : scoreDetails;
        const totalScore = totalsBase.reduce((sum, d) => sum + (d.score ?? 0), 0);
        const totalMax = totalsBase.reduce((sum, d) => sum + (d.max_points ?? 0), 0);
        exportItems.push({
          answerId: answer.id,
          studentName: student?.name ?? "-",
          studentId: student?.student_id ?? "-",
          createdAt: answer.created_at,
          totalScore,
          totalMax,
          answerText: answerDetail.answer_text || "",
          scoreDetails,
        });
      } catch {
        exportItems.push({
          answerId: answer.id,
          studentName: student?.name ?? "-",
          studentId: student?.student_id ?? "-",
          createdAt: answer.created_at,
          totalScore: resultsMap[answer.id]?.total_score,
          totalMax: resultsMap[answer.id]?.total_max,
          answerText: "",
          scoreDetails: [],
        });
      }
    }

    return exportItems;
  };

  const buildHtml = (exportItems: Array<{
    answerId: number;
    studentName: string;
    studentId: string;
    createdAt?: string;
    totalScore?: number;
    totalMax?: number;
    answerText: string;
    scoreDetails: ScoreDetail[];
  }>) => {
    const title = selectedExam
      ? `${exams.find((exam) => exam.id === selectedExam)?.name ?? "채점 내역"}`
      : "채점 내역";

    const listHtml = exportItems
      .map((item, index) => {
        const formatted = formatAnswerForDisplay(item.answerText);
        const { chunks, order } = splitByProblemHeadings(formatted);
        const problemOrder = order.length ? order : ["1", "2", "3"];
        const scoreByProblem: Record<
          string,
          {
            nodes: Record<string, ScoreDetail & { children: string[] }>;
            roots: string[];
          }
        > = {};

        item.scoreDetails.forEach((detail) => {
          const problemId = detail.section_id.split(".")[0];
          if (!scoreByProblem[problemId]) {
            scoreByProblem[problemId] = { nodes: {}, roots: [] };
          }
          scoreByProblem[problemId].nodes[detail.section_id] = { ...detail, children: [] };
        });

        Object.entries(scoreByProblem).forEach(([problemId, data]) => {
          Object.keys(data.nodes).forEach((sectionId) => {
            const parts = sectionId.split(".");
            const parentId = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
            if (parentId && data.nodes[parentId]) {
              data.nodes[parentId].children.push(sectionId);
            } else {
              data.roots.push(sectionId);
            }
          });
        });

        const buildScoreTreeHtml = (problemId: string) => {
          const group = scoreByProblem[problemId];
          if (!group) return "<div class='empty'>채점 내역이 없습니다.</div>";
          const renderNode = (nodeId: string, depth: number): string => {
            const detail = group.nodes[nodeId];
            if (!detail) return "";
            const isLeaf = detail.is_leaf !== false;
            const deductions = detail.deductions || [];
            const hasDeductions = deductions.length > 0;
            const deductionsHtml = hasDeductions
              ? `<ul class="deductions">${deductions
                  .map((d) => `<li>- ${escapeHtml(d.reason)} (${d.penalty})</li>`)
                  .join("")}</ul>`
              : "";
            const noteHtml = detail.llm?.note
              ? `<div class="note ${hasDeductions ? "note-bad" : "note-ok"}">${escapeHtml(detail.llm.note)}</div>`
              : "";
            const body = isLeaf
              ? `<div>점수: ${detail.score} / ${detail.max_points}</div>${deductionsHtml}${noteHtml}`
              : "";
            return `
              <div class="score-card ${isLeaf ? "" : "score-parent"}" style="margin-left:${depth * 12}px">
                <div class="score-title">${escapeHtml(detail.section_id)} ${escapeHtml(detail.title)}</div>
                ${body}
              </div>
              ${detail.children.map((childId) => renderNode(childId, depth + 1)).join("")}
            `;
          };

          return group.roots.map((rootId) => renderNode(rootId, 0)).join("") || "<div class='empty'>채점 내역이 없습니다.</div>";
        };

        const problemTabs = problemOrder
          .map((pid, idx) => {
            const totals = (() => {
              const leafDetails = item.scoreDetails.filter((d) => d.is_leaf && d.section_id.startsWith(`${pid}.`));
              const base = leafDetails.length ? leafDetails : item.scoreDetails.filter((d) => d.section_id.startsWith(`${pid}.`));
              const score = base.reduce((sum, d) => sum + (d.score ?? 0), 0);
              const max = base.reduce((sum, d) => sum + (d.max_points ?? 0), 0);
              return { score, max };
            })();
            return `
              <button class="tab-btn ${idx === 0 ? "active" : ""}" data-target="p-${item.answerId}-${pid}">
                문제 ${pid}<span class="tab-score">${totals.score.toFixed(2)}/${totals.max.toFixed(2)}</span>
              </button>`;
          })
          .join("");

        const problemPanels = problemOrder
          .map((pid, idx) => {
            const answerChunk = chunks[pid] || formatted;
            return `
              <div class="panel ${idx === 0 ? "active" : ""}" id="p-${item.answerId}-${pid}">
                <div class="panel-grid">
                  <div>
                    <h4>학생 답안</h4>
                    <pre>${escapeHtml(answerChunk)}</pre>
                  </div>
                  <div>
                    <h4>채점 내역</h4>
                    ${buildScoreTreeHtml(pid)}
                  </div>
                </div>
              </div>
            `;
          })
          .join("");

        return {
          list: `
            <div class="review-item ${index === 0 ? "active" : ""}" data-target="review-${item.answerId}">
              <div class="student">${escapeHtml(item.studentName)} (${escapeHtml(item.studentId)})</div>
              <div class="score">${item.totalScore?.toFixed(2) ?? "-"} / ${item.totalMax?.toFixed(2) ?? "-"}</div>
              <div class="meta">답안 ID ${item.answerId} · ${escapeHtml(formatDateOnly(item.createdAt))}</div>
            </div>
          `,
          detail: `
            <div class="review-detail ${index === 0 ? "active" : ""}" id="review-${item.answerId}">
              <div class="answer-body">
                <div class="tabs">${problemTabs}</div>
                ${problemPanels}
              </div>
            </div>
          `,
        };
      });

    const listHtmlString = listHtml.map((item) => item.list).join("");
    const detailHtmlString = listHtml.map((item) => item.detail).join("");

    const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #111; }
    h1 { font-size: 20px; margin-bottom: 16px; }
    .review-layout { display: grid; grid-template-columns: 1fr 3fr; gap: 16px; align-items: start; }
    .review-list { border: 1px solid #ddd; border-radius: 8px; padding: 12px; background: #f9fafb; max-height: 80vh; overflow-y: auto; }
    .review-item { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; background: #fff; cursor: pointer; margin-bottom: 8px; }
    .review-item:last-child { margin-bottom: 0; }
    .review-item.active { border-color: #2563eb; background: #eff6ff; }
    .review-detail-container { position: sticky; top: 16px; align-self: start; max-height: 80vh; overflow-y: auto; }
    .review-detail { border: 1px solid #ddd; border-radius: 8px; padding: 12px; display: none; }
    .review-detail.active { display: block; }
    .student { font-weight: 600; }
    .score { color: #2563eb; font-weight: 600; }
    .meta { color: #666; font-size: 12px; }
    .answer-body { margin-top: 12px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .tab-btn { border: 1px solid #ddd; border-radius: 6px; padding: 6px 10px; background: #f8f8f8; cursor: pointer; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
    .tab-btn.active { background: #2563eb; color: #fff; border-color: #2563eb; }
    .tab-score { font-size: 12px; color: inherit; }
    .panel { display: none; }
    .panel.active { display: block; }
    .panel-grid { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
    pre { background: #f8f8f8; padding: 12px; border-radius: 6px; white-space: pre-wrap; }
    .score-card { border: 1px solid #eee; border-radius: 6px; padding: 10px; margin-bottom: 8px; }
    .score-title { font-weight: 600; margin-bottom: 4px; }
    .score-parent { background: #f9fafb; }
    .deductions { color: #dc2626; margin: 6px 0 0 18px; }
    .note { font-size: 12px; margin-top: 4px; }
    .note-ok { color: #444; }
    .note-bad { color: #dc2626; }
    .empty { color: #888; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)} - 채점 내역</h1>
  <div class="review-layout">
    <div class="review-list">
      ${listHtmlString}
    </div>
    <div class="review-detail-container">
      ${detailHtmlString}
    </div>
  </div>
  <script>
    document.querySelectorAll('.review-item').forEach((item) => {
      item.addEventListener('click', () => {
        const target = item.getAttribute('data-target');
        document.querySelectorAll('.review-item').forEach((i) => i.classList.remove('active'));
        document.querySelectorAll('.review-detail').forEach((d) => d.classList.remove('active'));
        item.classList.add('active');
        const panel = document.getElementById(target);
        if (panel) panel.classList.add('active');
      });
    });

    document.querySelectorAll('.review-detail').forEach((detail) => {
      const buttons = detail.querySelectorAll('.tab-btn');
      const panels = detail.querySelectorAll('.panel');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = btn.getAttribute('data-target');
          buttons.forEach((b) => b.classList.remove('active'));
          panels.forEach((p) => p.classList.remove('active'));
          btn.classList.add('active');
          const panel = detail.querySelector('#' + target);
          if (panel) panel.classList.add('active');
        });
      });
    });
  </script>
</body>
</html>`;

    return html;
  };

  const handleExportHtml = async (list: AnswerItem[], mode: ExportMode) => {
    setExportMessage("");
    if (!list.length) {
      setExportMessage("내보낼 답안이 없습니다.");
      return;
    }
    setExportMessage("내보내는 중...");
    const exportItems = await buildExportItems(list);
    if (mode === "batch") {
      exportItems.forEach((item) => {
        const html = buildHtml([item]);
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${item.studentId}_${item.studentName}_채점내역.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    } else {
      const html = buildHtml(exportItems);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selectedExam ? exams.find((exam) => exam.id === selectedExam)?.name ?? "채점내역" : "채점내역"}-채점내역.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    setExportMessage("내보내기 완료");
  };

  const handleExportPdf = async (list: AnswerItem[], mode: ExportMode) => {
    setExportMessage("");
    if (!list.length) {
      setExportMessage("내보낼 답안이 없습니다.");
      return;
    }
    setExportMessage("내보내는 중...");
    try {
      const answerIds = list.map((answer) => answer.id);
      const response = await gradeApi.exportPdf({ answer_ids: answerIds, mode });
      const blob = new Blob([response.data], {
        type: response.headers["content-type"] || "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const disposition = response.headers["content-disposition"] || "";
      const match = disposition.match(/filename=\"?([^\";]+)\"?/);
      a.href = url;
      a.download = match?.[1] ?? (mode === "batch" ? "채점내역.zip" : "채점내역.pdf");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportMessage("내보내기 완료");
    } catch {
      setExportMessage("내보내기 실패");
    }
  };

  return (
    <div className="grid gap-6">
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">채점 내역 검토</h2>
        <div className="grid gap-3 md:grid-cols-3 mb-4">
          <div>
            <label className="block mb-1">시험 선택</label>
            <select
              className="border p-2 rounded w-full"
              value={selectedExam ?? ""}
              onChange={(e) => setSelectedExam(Number(e.target.value))}
            >
              <option value="">선택</option>
              {exams.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block mb-1">학생 필터</label>
            <select
              className="border p-2 rounded w-full"
              value={selectedStudentFilter ?? ""}
              onChange={(e) => setSelectedStudentFilter(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">전체</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name} ({student.student_id})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block mb-1">학생 검색</label>
            <input
              className="border p-2 rounded w-full"
              placeholder="학번 또는 이름"
              value={studentSearch}
              onChange={(e) => setStudentSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex flex-wrap gap-2 items-center">
            <button
              className={`px-3 py-2 rounded border ${
                exportScope === "all" ? "bg-blue-600 text-white" : "bg-gray-100"
              }`}
              onClick={() => setExportScope("all")}
            >
              전체
            </button>
            <button
              className={`px-3 py-2 rounded border ${
                exportScope === "selected" ? "bg-blue-600 text-white" : "bg-gray-100"
              }`}
              onClick={() => setExportScope("selected")}
            >
              선택
            </button>
            <span className="mx-1 text-gray-300">|</span>
            <button
              className={`px-3 py-2 rounded border ${
                exportFormat === "html" ? "bg-blue-600 text-white" : "bg-gray-100"
              }`}
              onClick={() => setExportFormat("html")}
            >
              HTML
            </button>
            <button
              className={`px-3 py-2 rounded border ${
                exportFormat === "pdf" ? "bg-blue-600 text-white" : "bg-gray-100"
              }`}
              onClick={() => setExportFormat("pdf")}
            >
              PDF
            </button>
            <button
              className={`px-3 py-2 rounded border ${
                exportMode === "single" ? "bg-blue-600 text-white" : "bg-gray-100"
              }`}
              onClick={() => setExportMode("single")}
            >
              합본
            </button>
            <button
              className={`px-3 py-2 rounded border ${
                exportMode === "batch" ? "bg-blue-600 text-white" : "bg-gray-100"
              }`}
              onClick={() => setExportMode("batch")}
            >
              개별
            </button>
          </div>
          <div className="flex items-center gap-3">
            {exportMessage && <span className="text-sm text-gray-600">{exportMessage}</span>}
            <button
              className="bg-gray-900 text-white rounded px-3 py-2"
              onClick={() => {
                const target = exportScope === "all"
                  ? sortedAnswers
                  : sortedAnswers.filter((answer) => selectedAnswerIds.has(answer.id));
                if (exportFormat === "html") {
                  handleExportHtml(target, exportMode);
                } else {
                  handleExportPdf(target, exportMode);
                }
              }}
            >
              내보내기
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-3">
          <button
            className={`px-3 py-2 rounded border ${
              answerSortKey === "name" ? "bg-blue-600 text-white" : "bg-gray-100"
            }`}
            onClick={() => setAnswerSortKey("name")}
          >
            가나다순
          </button>
          <button
            className={`px-3 py-2 rounded border ${
              answerSortKey === "student_id" ? "bg-blue-600 text-white" : "bg-gray-100"
            }`}
            onClick={() => setAnswerSortKey("student_id")}
          >
            학번순
          </button>
          <button
            className={`px-3 py-2 rounded border ${
              answerSortKey === "score_desc" ? "bg-blue-600 text-white" : "bg-gray-100"
            }`}
            onClick={() => setAnswerSortKey("score_desc")}
          >
            높은 점수순
          </button>
        </div>

        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="min-w-full text-sm border">
            <thead className="bg-gray-100">
              <tr>
                <th className="text-left p-2 border">
                  <input
                    type="checkbox"
                    checked={sortedAnswers.length > 0 && selectedAnswerIds.size === sortedAnswers.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th className="text-left p-2 border">답안 ID</th>
                <th className="text-left p-2 border">학생</th>
                <th className="text-left p-2 border">점수</th>
                <th className="text-left p-2 border">등록일</th>
                <th className="text-left p-2 border">선택</th>
              </tr>
            </thead>
            <tbody>
              {sortedAnswers.map((answer) => {
                const student = studentsById.get(answer.student_id);
                const result = resultsMap[answer.id];
                return (
                  <tr
                    key={answer.id}
                    className={`border-t ${selectedAnswerId === answer.id ? "bg-yellow-50" : ""}`}
                  >
                    <td className="p-2 border">
                      <input
                        type="checkbox"
                        checked={selectedAnswerIds.has(answer.id)}
                        onChange={() => toggleSelected(answer.id)}
                      />
                    </td>
                    <td className="p-2 border">{answer.id}</td>
                    <td className="p-2 border">
                      {student?.name ?? "-"} ({student?.student_id ?? "-"})
                    </td>
                    <td className="p-2 border">
                      {result ? `${result.total_score} / ${result.total_max}` : "-"}
                    </td>
                    <td className="p-2 border">{formatDateOnly(answer.created_at)}</td>
                    <td className="p-2 border">
                      <button className="text-blue-600 underline" onClick={() => loadAnswerDetail(answer.id)}>
                        보기
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!answers.length && (
                <tr>
                  <td className="p-3 text-center text-gray-500" colSpan={6}>
                    조회된 답안이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

        {selectedAnswerId && (
        <div className="card h-[70vh] overflow-y-auto">
          <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-gray-600">
                  학생: {studentsById.get(answers.find((a) => a.id === selectedAnswerId)?.student_id ?? 0)?.name ?? "-"}
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <span>글씨 크기</span>
                  <button
                    className="border px-2 py-1 rounded"
                    onClick={() => setAnswerFontSize((prev) => Math.max(12, prev - 1))}
                  >
                    -
                  </button>
                  <span>{answerFontSize}px</span>
                  <button
                    className="border px-2 py-1 rounded"
                    onClick={() => setAnswerFontSize((prev) => Math.min(20, prev + 1))}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex flex-col gap-2 border-r pr-2 w-20 self-start bg-white">
                  {(problemOrder.length ? problemOrder : ["1", "2", "3"]).map((pid) => {
                    const totals = problemTotals[pid];
                    return (
                      <button
                        key={pid}
                        className={`px-2 py-1 rounded text-sm text-left ${
                          selectedProblemTab === pid ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700"
                        }`}
                        onClick={() => setSelectedProblemTab(pid)}
                      >
                        <div className="font-semibold">문제 {pid}</div>
                        <div className="text-xs">
                          {totals ? totals.score.toFixed(2) : "0.00"}/{totals ? totals.max.toFixed(2) : "0.00"}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="flex-1" style={{ fontSize: `${answerFontSize}px` }}>
                  <div className="border rounded p-3 bg-gray-50">
                    {(problemChunks[selectedProblemTab] ?? formattedAnswer)
                      .split(/\r?\n/)
                      .map((line, lineIdx) => {
                        const level = detectHeadingLevel(line);
                        const indentLevel = level !== null ? Math.max(level - 1, 0) : 1;
                        const isHeading = level === 1;
                        return (
                          <div
                            key={`${lineIdx}-${line}`}
                            className={isHeading ? "font-semibold" : ""}
                            style={{ paddingLeft: 8 + indentLevel * 12 }}
                          >
                            {line}
                          </div>
                        );
                      })}
                  </div>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold mb-2">채점 내역</h3>
              {Object.entries(scoreTreeByProblem)
                .filter(([problemId]) => problemId === selectedProblemTab)
                .map(([problemId, group]) => (
                <div key={problemId} className="mb-4">
                  <div className="text-sm font-semibold text-gray-600 mb-2">문제 {problemId}</div>
                  {group.roots.map((rootId) => {
                    const renderNode = (nodeId: string, depth: number) => {
                      const detail = group.nodes[nodeId];
                      if (!detail) return null;
                      const hasDeductions = (detail.deductions || []).length > 0;
                      const isActive = activeSectionId === detail.section_id;
                      const isLeaf = detail.is_leaf !== false;
                      const childSummary = childScoreMap[detail.section_id];
                      return (
                        <div key={detail.section_id} style={{ marginLeft: depth * 12 }}>
                          <div
                            className={`w-full text-left border rounded p-2 mb-2 ${
                              isActive ? "border-blue-600 bg-blue-50" : "border-gray-200"
                            } ${isLeaf ? "" : "bg-gray-50 text-gray-500 cursor-not-allowed"}`}
                          >
                            <button
                              type="button"
                              className="w-full text-left font-semibold mb-1"
                              onClick={() => {
                                if (!isLeaf) return;
                                handleSelectDetail(detail);
                              }}
                            >
                              {detail.section_id} {detail.title}
                            </button>
                            {!isActive && isLeaf && (
                              <div className={hasDeductions ? "text-red-600" : "text-gray-800"}>
                                점수: {detail.score} / {detail.max_points}
                              </div>
                            )}
                            {!isActive && !isLeaf && (
                              <div className="text-sm text-gray-500">
                                하위 항목 합계: {childSummary ? childSummary.sum.toFixed(2) : "0.00"} /{" "}
                                {childSummary ? childSummary.max.toFixed(2) : "0.00"}
                              </div>
                            )}
                            {isActive && isLeaf && (
                              <div className="grid gap-2 mt-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm text-gray-600">점수</span>
                                  <input
                                    className="border p-1 rounded w-24"
                                    type="number"
                                    step="0.5"
                                    value={editScore}
                                    onChange={(e) => setEditScore(e.target.value)}
                                  />
                                  <span className="text-xs text-gray-500">/ {detail.max_points}</span>
                                </div>
                                <div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-sm font-semibold">감점 내역</span>
                                    <button
                                      className="text-blue-600 underline"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleAddDeduction();
                                      }}
                                    >
                                      감점 추가
                                    </button>
                                  </div>
                                  <div className="grid gap-2 mt-2">
                                    {editDeductions.map((deduction, index) => (
                                      <div
                                        key={`${detail.section_id}-${index}`}
                                        className="grid gap-2 md:grid-cols-[2fr_1fr_auto]"
                                      >
                                        <input
                                          className="border p-1 rounded"
                                          placeholder="감점 사유"
                                          value={deduction.reason}
                                          onChange={(e) =>
                                            setEditDeductions((prev) =>
                                              prev.map((item, idx) =>
                                                idx === index ? { ...item, reason: e.target.value } : item
                                              )
                                            )
                                          }
                                          onClick={(event) => event.stopPropagation()}
                                        />
                                        <input
                                          className="border p-1 rounded"
                                          placeholder="감점"
                                          type="number"
                                          step="0.5"
                                          value={deduction.penalty}
                                          onChange={(e) =>
                                            setEditDeductions((prev) =>
                                              prev.map((item, idx) =>
                                                idx === index ? { ...item, penalty: e.target.value } : item
                                              )
                                            )
                                          }
                                          onClick={(event) => event.stopPropagation()}
                                        />
                                        <button
                                          className="text-red-600 underline"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            handleRemoveDeduction(index);
                                          }}
                                        >
                                          삭제
                                        </button>
                                      </div>
                                    ))}
                                    {!editDeductions.length && (
                                      <div className="text-sm text-gray-800">감점 없음</div>
                                    )}
                                  </div>
                                </div>
                                <div>
                                  <label className="block text-sm mb-1">코멘트</label>
                                  <textarea
                                    className="border p-2 rounded w-full"
                                    rows={3}
                                    value={editNote}
                                    onChange={(e) => setEditNote(e.target.value)}
                                    onClick={(event) => event.stopPropagation()}
                                  />
                                </div>
                                <div className="flex items-center gap-3">
                                  <button
                                    className="bg-blue-600 text-white rounded px-3 py-1"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleSave();
                                    }}
                                    disabled={isSaving}
                                  >
                                    {isSaving ? "저장 중..." : "저장"}
                                  </button>
                                  {actionMessage && <span className="text-sm text-gray-600">{actionMessage}</span>}
                                </div>
                              </div>
                            )}
                            {isActive && !isLeaf && (
                              <div className="text-sm text-gray-500 mt-2">
                                하위 항목 합계: {childSummary ? childSummary.sum.toFixed(2) : "0.00"} /{" "}
                                {childSummary ? childSummary.max.toFixed(2) : "0.00"}
                              </div>
                            )}
                          </div>
                          {detail.children.map((childId) => renderNode(childId, depth + 1))}
                        </div>
                      );
                    };
                    return renderNode(rootId, 0);
                  })}
                </div>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
