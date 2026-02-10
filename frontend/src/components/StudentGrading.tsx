"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { answersApi, examsApi, gradeApi, studentsApi } from "@/lib/api";

type ScoreDetail = {
  section_id: string;
  title: string;
  max_points: number;
  score: number;
  deductions?: { reason: string; penalty: number }[];
  keywords?: string[];
  is_leaf?: boolean;
  is_bonus?: boolean;
  writing_status?: "Missing" | "Incomplete" | "Full";
  llm?: { note?: string };
};

type Student = {
  id: number;
  student_id: string;
  name: string;
  created_at?: string;
};

type Exam = {
  id: number;
  name: string;
  created_at?: string;
};

type AnswerItem = {
  id: number;
  exam_id: number;
  student_id: number;
  created_at?: string;
  has_result?: boolean;
};

type UploadItem = {
  file: File;
  inferredName: string;
  studentId: number | null;
};

type AnswerSortKey = "name" | "student_id" | "score_desc";

function splitParagraphs(text: string) {
  return text.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
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

function normalizeAnswerForUpload(text: string) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const headingRegex =
    /^\s*(?!제\d+(조|항|호)\b)(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}\.|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨIV]{1,6}(?=\s|$)|\d+\.|\(\d+\)|\([가나다라마바사아자차카타파하]\))/;

  const resultLines: string[] = [];
  let currentParagraph = "";

  const flushParagraph = () => {
    const trimmed = currentParagraph.trim();
    if (trimmed) {
      resultLines.push(trimmed);
    }
    currentParagraph = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // 빈 줄은 문단 구분으로 사용
    if (!line) {
      flushParagraph();
      continue;
    }

    // 로마숫자/번호/괄호 등 헤딩 라인은 항상 단독 줄로 유지
    if (headingRegex.test(line)) {
      flushParagraph();
      resultLines.push(line);
      continue;
    }

    // 그 외 줄은 같은 문단 안에서 공백으로만 이어 붙임
    if (!currentParagraph) {
      currentParagraph = line;
    } else {
      currentParagraph += " " + line;
    }
  }

  flushParagraph();
  return resultLines.join("\n");
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function extractLastToken(filename: string) {
  const base = filename.replace(/\.[^/.]+$/, "");
  const parts = base.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function findStudentIdByToken(students: Student[], token: string) {
  if (!token) return null;
  const normalized = normalizeText(token);
  let match = students.find((student) => normalizeText(student.name) === normalized);
  if (!match) {
    match = students.find((student) => normalizeText(student.name).startsWith(normalized));
  }
  return match?.id ?? null;
}

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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

function buildUploadQueue(files: File[], students: Student[], prev: UploadItem[]) {
  const prevMap = new Map(prev.map((item) => [`${item.file.name}-${item.file.size}`, item.studentId]));
  return files.map((file) => {
    const key = `${file.name}-${file.size}`;
    const inferredName = extractLastToken(file.name);
    const existingStudentId = prevMap.get(key) ?? null;
    const matched = existingStudentId ?? findStudentIdByToken(students, inferredName);
    return {
      file,
      inferredName,
      studentId: matched ?? null,
    };
  });
}

export default function StudentGrading() {
  const showPdfUpload = false;
  const [exams, setExams] = useState<Exam[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [answers, setAnswers] = useState<AnswerItem[]>([]);
  const [resultsMap, setResultsMap] = useState<Record<number, { total_score: number; total_max: number }>>({});

  const [selectedExam, setSelectedExam] = useState<number | null>(null);
  const [selectedStudentFilter, setSelectedStudentFilter] = useState<number | null>(null);
  const [studentSearch, setStudentSearch] = useState("");
  const [answerSortKey, setAnswerSortKey] = useState<AnswerSortKey>("name");

  const [answerFiles, setAnswerFiles] = useState<File[]>([]);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [exportMessage, setExportMessage] = useState("");

  const [textExamId, setTextExamId] = useState<number | null>(null);
  const [textStudentId, setTextStudentId] = useState<number | null>(null);
  const [problem1Text, setProblem1Text] = useState("");
  const [problem2Text, setProblem2Text] = useState("");
  const [problem3Text, setProblem3Text] = useState("");
  const [textUploadMessage, setTextUploadMessage] = useState("");

  const [selectedAnswerId, setSelectedAnswerId] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [scoreDetails, setScoreDetails] = useState<ScoreDetail[]>([]);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [activeParagraphIndex, setActiveParagraphIndex] = useState<number | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [selectedProblemTab, setSelectedProblemTab] = useState("1");
  const [answerFontSize, setAnswerFontSize] = useState(14);
  const [regradingAnswerId, setRegradingAnswerId] = useState<number | null>(null);

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

  useEffect(() => {
    setUploadQueue((prev) => buildUploadQueue(answerFiles, students, prev));
  }, [answerFiles, students]);

  useEffect(() => {
    if (!selectedAnswerId) return;
    const exists = answers.some((answer) => answer.id === selectedAnswerId);
    if (!exists) {
      setSelectedAnswerId(null);
      setAnswerText("");
      setScoreDetails([]);
    }
  }, [answers, selectedAnswerId]);

  const handleUploadAnswers = async () => {
    if (!selectedExam) {
      setUploadMessage("시험을 선택하세요.");
      return;
    }
    if (!uploadQueue.length) {
      setUploadMessage("업로드할 파일을 선택하세요.");
      return;
    }
    const missing = uploadQueue.filter((item) => !item.studentId);
    if (missing.length) {
      setUploadMessage(`학생 매칭이 안 된 파일이 ${missing.length}개 있습니다.`);
      return;
    }
    setUploadMessage("업로드 중...");
    let success = 0;
    const failed: string[] = [];
    for (const item of uploadQueue) {
      try {
        const form = new FormData();
        form.append("exam_id", String(selectedExam));
        form.append("student_id", String(item.studentId));
        form.append("file", item.file);
        const res = await answersApi.upload(form);
        await gradeApi.run(res.answer_id, true);
        success += 1;
      } catch {
        failed.push(item.file.name);
      }
    }
    await loadAnswers(selectedExam, selectedStudentFilter);
    setAnswerFiles([]);
    setUploadQueue([]);
    if (failed.length) {
      setUploadMessage(`성공 ${success}건, 실패 ${failed.length}건: ${failed.join(", ")}`);
    } else {
      setUploadMessage(`업로드 및 채점 완료: ${success}건`);
    }
  };

  const handleQueueStudentChange = (index: number, studentIdValue: string) => {
    const parsed = studentIdValue ? Number(studentIdValue) : null;
    setUploadQueue((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, studentId: parsed } : item))
    );
  };

  const handleRemoveQueueItem = (index: number) => {
    setAnswerFiles((prev) => prev.filter((_, idx) => idx !== index));
    setUploadQueue((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleUploadText = async () => {
    if (!textExamId) {
      setTextUploadMessage("시험을 선택하세요.");
      return;
    }
    if (!textStudentId) {
      setTextUploadMessage("학생을 선택하세요.");
      return;
    }
    if (!problem1Text.trim() || !problem2Text.trim() || !problem3Text.trim()) {
      setTextUploadMessage("모든 문제 답안을 입력하세요.");
      return;
    }
    setTextUploadMessage("업로드 중...");
    try {
      const form = new FormData();
      form.append("exam_id", String(textExamId));
      form.append("student_id", String(textStudentId));
      form.append("problem1_text", normalizeAnswerForUpload(problem1Text));
      form.append("problem2_text", normalizeAnswerForUpload(problem2Text));
      form.append("problem3_text", normalizeAnswerForUpload(problem3Text));
      const res = await answersApi.uploadText(form);
      await gradeApi.run(res.answer_id, true);
      setTextUploadMessage("업로드 및 채점 완료!");
      setProblem1Text("");
      setProblem2Text("");
      setProblem3Text("");
      if (selectedExam) await loadAnswers(selectedExam, selectedStudentFilter);
    } catch {
      setTextUploadMessage("업로드 실패");
    }
  };

  const handleExportHtml = async () => {
    setExportMessage("");
    if (!answers.length) {
      setExportMessage("내보낼 답안이 없습니다.");
      return;
    }
    setExportMessage("내보내는 중...");

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

    for (const answer of answers) {
      const student = studentsById.get(answer.student_id);
      try {
        const [answerDetail, result] = await Promise.all([
          answersApi.get(answer.id),
          gradeApi.getResult(answer.id),
        ]);
        const scoreDetails: ScoreDetail[] = result.score_details || [];
        const leafDetails = scoreDetails.filter((d: ScoreDetail) => d.is_leaf);
        const totalsBase = leafDetails.length ? leafDetails : scoreDetails;
        const totalScore = totalsBase.reduce((sum: number, d: ScoreDetail) => sum + (d.score ?? 0), 0);
        const totalMax = totalsBase.reduce((sum: number, d: ScoreDetail) => sum + (d.max_points ?? 0), 0);
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

    const title = selectedExam
      ? `${exams.find((exam) => exam.id === selectedExam)?.name ?? "학생 답안 리스트"}`
      : "학생 답안 리스트";

    const itemsHtml = exportItems
      .map((item) => {
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
            const childSummary = detail.is_leaf
              ? null
              : (() => {
                  const children = Object.values(group.nodes).filter((d: ScoreDetail) =>
                    d.section_id.startsWith(`${detail.section_id}.`) && d.is_leaf
                  );
                  const sum = children.reduce((acc, d) => acc + (d.score ?? 0), 0);
                  const max = children.reduce((acc, d) => acc + (d.max_points ?? 0), 0);
                  return { sum, max };
                })();

            const deductionsHtml = hasDeductions
              ? `<ul class="deductions">${deductions
                  .map((d) => `<li>- ${escapeHtml(d.reason)} (${d.penalty})</li>`)
                  .join("")}</ul>`
              : "";
            const noteHtml = detail.llm?.note
              ? `<div class="note ${hasDeductions ? "note-bad" : "note-ok"}">${escapeHtml(detail.llm.note)}</div>`
              : "";

            const body = isLeaf
              ? detail.is_bonus
                ? `<div style="color:#2563eb">가산: +${detail.score}</div>${deductionsHtml}${noteHtml}`
                : `<div>점수: ${detail.score} / ${detail.max_points}</div>${deductionsHtml}${noteHtml}`
              : `<div class="subsum">하위 항목 합계: ${childSummary ? childSummary.sum.toFixed(2) : "0.00"} / ${
                  childSummary ? childSummary.max.toFixed(2) : "0.00"
                }</div>`;

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
              const leafDetails = item.scoreDetails.filter(
                (d: ScoreDetail) => d.is_leaf && d.section_id.startsWith(`${pid}.`)
              );
              const base = leafDetails.length
                ? leafDetails
                : item.scoreDetails.filter((d: ScoreDetail) => d.section_id.startsWith(`${pid}.`));
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

        return `
          <details class="answer-item">
            <summary>
              <span class="student">${escapeHtml(item.studentName)} (${escapeHtml(item.studentId)})</span>
              <span class="score">${item.totalScore?.toFixed(2) ?? "-"} / ${item.totalMax?.toFixed(2) ?? "-"}</span>
              <span class="meta">답안 ID ${item.answerId} · ${escapeHtml(formatDate(item.createdAt))}</span>
            </summary>
            <div class="answer-body">
              <div class="tabs">${problemTabs}</div>
              ${problemPanels}
            </div>
          </details>
        `;
      })
      .join("");

    const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #111; }
    h1 { font-size: 20px; margin-bottom: 16px; }
    .answer-item { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
    summary { cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
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
    .subsum { font-size: 12px; color: #666; }
    .deductions { color: #dc2626; margin: 6px 0 0 18px; }
    .note { font-size: 12px; margin-top: 4px; }
    .note-ok { color: #444; }
    .note-bad { color: #dc2626; }
    .empty { color: #888; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)} - 학생 답안 리스트</h1>
  ${itemsHtml}
  <script>
    document.querySelectorAll('.answer-item').forEach((item) => {
      const buttons = item.querySelectorAll('.tab-btn');
      const panels = item.querySelectorAll('.panel');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = btn.getAttribute('data-target');
          buttons.forEach((b) => b.classList.remove('active'));
          panels.forEach((p) => p.classList.remove('active'));
          btn.classList.add('active');
          const panel = item.querySelector('#' + target);
          if (panel) panel.classList.add('active');
        });
      });
    });
  </script>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}-학생답안리스트.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExportMessage("내보내기 완료");
  };

  const loadAnswerDetail = async (answerId: number) => {
    setSelectedAnswerId(answerId);
    const answer = await answersApi.get(answerId);
    const result = await gradeApi.getResult(answerId);
    setAnswerText(answer.answer_text || "");
    setScoreDetails(result.score_details || []);
  };

  const handleRegrade = async (answerId: number) => {
    if (!selectedExam) return;
    setRegradingAnswerId(answerId);
    try {
      await gradeApi.run(answerId, true);
      await loadAnswers(selectedExam, selectedStudentFilter);
      if (selectedAnswerId === answerId) await loadAnswerDetail(answerId);
    } catch {
      alert("재채점 요청 실패");
    } finally {
      setRegradingAnswerId(null);
    }
  };

  const studentsById = useMemo(() => {
    return new Map(students.map((student) => [student.id, student]));
  }, [students]);

  const sortedStudents = useMemo(() => {
    return [...students].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ko"));
  }, [students]);

  const selectedAnswer = useMemo(
    () => answers.find((answer) => answer.id === selectedAnswerId) || null,
    [answers, selectedAnswerId]
  );
  const selectedStudent = useMemo(
    () => (selectedAnswer ? studentsById.get(selectedAnswer.student_id) ?? null : null),
    [selectedAnswer, studentsById]
  );

  const filteredStudents = useMemo(() => {
    const keyword = normalizeText(studentSearch);
    const list = !keyword ? students : students.filter((student) => normalizeText(`${student.student_id} ${student.name}`).includes(keyword));
    return [...list].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ko"));
  }, [students, studentSearch]);

  const sortedAnswers = useMemo(() => {
    const list = [...answers];
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
  }, [answers, answerSortKey, resultsMap, studentsById]);

  const formattedAnswer = useMemo(() => formatAnswerForDisplay(answerText), [answerText]);
  const { chunks: problemChunks } = useMemo(
    () => splitByProblemHeadings(formattedAnswer),
    [formattedAnswer]
  );
  const displayedAnswer = useMemo(() => {
    const chunk = problemChunks[selectedProblemTab];
    return chunk ? chunk : formattedAnswer;
  }, [formattedAnswer, problemChunks, selectedProblemTab]);
  const paragraphs = useMemo(() => splitParagraphs(displayedAnswer), [displayedAnswer]);

  const paragraphSectionMap = useMemo(() => {
    return paragraphs.map((para) => {
      const normalized = para.replace(/\s+/g, "");
      const matched = scoreDetails.find((detail) =>
        (detail.keywords || []).some((kw) => normalized.includes(kw))
      );
      return matched?.section_id ?? null;
    });
  }, [paragraphs, scoreDetails]);

  const firstParagraphIndexBySection = useMemo(() => {
    const map: Record<string, number> = {};
    paragraphSectionMap.forEach((sectionId, index) => {
      if (sectionId && map[sectionId] === undefined) {
        map[sectionId] = index;
      }
    });
    return map;
  }, [paragraphSectionMap]);

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

  

  const scoreTreeByProblem = useMemo(() => {
    const byProblem: Record<string, { order: string[]; roots: string[]; nodes: Record<string, ScoreDetail & { children: string[] }> }> = {};

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

  return (
    <div className="grid gap-6">
      {showPdfUpload && (
        <div className="card">
          <h2 className="text-xl font-semibold mb-4">학생 답안 업로드</h2>
          <div className="grid gap-3 md:grid-cols-3">
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
            <div className="md:col-span-2">
              <label className="block mb-1">답안 PDF (다중 업로드 가능)</label>
              <input
                type="file"
                multiple
                onChange={(e) => {
                  setAnswerFiles(Array.from(e.target.files ?? []));
                  setUploadMessage("");
                }}
              />
              <p className="text-sm text-gray-600 mt-1">
                파일명의 마지막 단어(공백 기준)를 학생 이름과 매칭합니다. 예: [베리타스 3개월 기록형 답안지] 민법 1회 2602-0006 정윤서.pdf
              </p>
            </div>
          </div>

        {uploadQueue.length > 0 && (
          <div className="mt-4 border rounded p-3">
            <div className="font-semibold mb-2">업로드 대기 목록</div>
            <div className="grid gap-2">
              {uploadQueue.map((item, index) => (
                <div key={`${item.file.name}-${item.file.size}`} className="grid md:grid-cols-4 gap-2 items-center">
                  <div className="md:col-span-2">
                    <div className="text-sm font-semibold">{item.file.name}</div>
                    <div className="text-xs text-gray-600">추출명: {item.inferredName || "-"}</div>
                  </div>
                  <select
                    className="border p-2 rounded"
                    value={item.studentId ?? ""}
                    onChange={(e) => handleQueueStudentChange(index, e.target.value)}
                  >
                    <option value="">학생 선택</option>
                    {sortedStudents.map((student) => (
                      <option key={student.id} value={student.id}>
                        {student.name} ({student.student_id})
                      </option>
                    ))}
                  </select>
                  <button
                    className="text-sm text-red-600 underline"
                    onClick={() => handleRemoveQueueItem(index)}
                  >
                    제거
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

          <button className="bg-blue-600 text-white rounded px-4 py-2 mt-3" onClick={handleUploadAnswers}>
            답안 업로드 & 채점
          </button>
          {uploadMessage && <div className="mt-2 text-sm text-gray-700">{uploadMessage}</div>}
        </div>
      )}

      <div className="card">
        <h2 className="text-xl font-semibold mb-4">학생 답안 텍스트 직접 입력</h2>
        <div className="grid gap-3 md:grid-cols-2 mb-4">
          <div>
            <label className="block mb-1">시험 선택</label>
            <select
              className="border p-2 rounded w-full"
              value={textExamId ?? ""}
              onChange={(e) => setTextExamId(Number(e.target.value))}
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
            <label className="block mb-1">학생 선택</label>
            <select
              className="border p-2 rounded w-full"
              value={textStudentId ?? ""}
              onChange={(e) => setTextStudentId(Number(e.target.value))}
            >
              <option value="">선택</option>
              {sortedStudents.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name} ({student.student_id})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4">
          <div>
            <label className="block mb-1 font-semibold">문제 1 답안</label>
            <textarea
              className="border p-2 rounded w-full"
              rows={8}
              placeholder="문제 1 답안을 여기에 복사-붙여넣기 하세요"
              value={problem1Text}
              onChange={(e) => setProblem1Text(e.target.value)}
            />
          </div>
          <div>
            <label className="block mb-1 font-semibold">문제 2 답안</label>
            <textarea
              className="border p-2 rounded w-full"
              rows={8}
              placeholder="문제 2 답안을 여기에 복사-붙여넣기 하세요"
              value={problem2Text}
              onChange={(e) => setProblem2Text(e.target.value)}
            />
          </div>
          <div>
            <label className="block mb-1 font-semibold">문제 3 답안</label>
            <textarea
              className="border p-2 rounded w-full"
              rows={8}
              placeholder="문제 3 답안을 여기에 복사-붙여넣기 하세요"
              value={problem3Text}
              onChange={(e) => setProblem3Text(e.target.value)}
            />
          </div>
        </div>

        <button className="bg-green-600 text-white rounded px-4 py-2 mt-3" onClick={handleUploadText}>
          제출 & 채점
        </button>
        {textUploadMessage && <div className="mt-2 text-sm text-gray-700">{textUploadMessage}</div>}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">학생 답안 리스트</h2>
          <div className="flex items-center gap-3">
            {exportMessage && <span className="text-sm text-gray-600">{exportMessage}</span>}
            <button className="bg-gray-900 text-white rounded px-3 py-2" onClick={handleExportHtml}>
              HTML 내보내기
            </button>
          </div>
        </div>
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
            <label className="block mb-1">학생 검색</label>
            <input
              className="border p-2 rounded w-full"
              placeholder="학번 또는 이름"
              value={studentSearch}
              onChange={(e) => setStudentSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="block mb-1">학생 필터</label>
            <select
              className="border p-2 rounded w-full"
              value={selectedStudentFilter ?? ""}
              onChange={(e) => setSelectedStudentFilter(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">전체</option>
              {filteredStudents.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name} ({student.student_id})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
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
        </div>

        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="min-w-full text-sm border">
            <thead className="bg-gray-100">
              <tr>
                <th className="text-left p-2 border">답안 ID</th>
                <th className="text-left p-2 border">학생</th>
                <th className="text-left p-2 border">채점 상태</th>
                <th className="text-left p-2 border">점수</th>
                <th className="text-left p-2 border">등록일</th>
                <th className="text-left p-2 border">상세</th>
                <th className="text-left p-2 border">재채점</th>
                <th className="text-left p-2 border">삭제</th>
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
                    <td className="p-2 border">{answer.id}</td>
                    <td className="p-2 border">
                      {student?.name ?? "-"} ({student?.student_id ?? "-"})
                    </td>
                    <td className="p-2 border">{answer.has_result ? "완료" : "미완료"}</td>
                    <td className="p-2 border">
                      {result ? `${result.total_score} / ${result.total_max}` : "-"}
                    </td>
                    <td className="p-2 border">{formatDateOnly(answer.created_at)}</td>
                    <td className="p-2 border">
                      <button className="text-blue-600 underline" onClick={() => loadAnswerDetail(answer.id)}>
                        보기
                      </button>
                    </td>
                    <td className="p-2 border">
                      <button
                        className="text-green-600 underline disabled:opacity-50"
                        disabled={regradingAnswerId === answer.id}
                        onClick={() => handleRegrade(answer.id)}
                      >
                        {regradingAnswerId === answer.id ? "채점 중..." : "재채점"}
                      </button>
                    </td>
                    <td className="p-2 border">
                      <button
                        className="text-red-600 underline"
                        onClick={async () => {
                          if (confirm("삭제하시겠습니까?")) {
                            try {
                              await answersApi.delete(answer.id);
                              if (selectedExam) await loadAnswers(selectedExam, selectedStudentFilter);
                            } catch {
                              alert("삭제 실패");
                            }
                          }
                        }}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!answers.length && (
                <tr>
                  <td className="p-3 text-center text-gray-500" colSpan={8}>
                    조회된 답안이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedAnswerId && (
          <div className="mt-10 border-t h-[60vh] overflow-y-auto bg-white">
          <div className="sticky top-0 z-10 bg-white border-b pb-2">
            <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">
                  학생 답안
                  {selectedStudent && (
                    <span className="ml-2 text-sm text-gray-600">
                      {selectedStudent.name} ({selectedStudent.student_id})
                    </span>
                  )}
                </h3>
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
              <div className="flex items-center">
                <h3 className="font-semibold">채점 내역</h3>
              </div>
            </div>
          </div>
          <div className="grid gap-6 md:grid-cols-[3fr_2fr] pt-6">
            <div>
              <div className="flex gap-3">
                <div className="flex flex-col gap-2 border-r pr-2 w-20 sticky top-16 self-start bg-white">
                  {["1", "2", "3"].map((num) => {
                    const total = problemTotals[num];
                    return (
                    <button
                        key={num}
                        className={`px-2 py-1 rounded text-sm text-left ${
                          selectedProblemTab === num ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700"
                        }`}
                        onClick={() => setSelectedProblemTab(num)}
                      >
                        <div className="font-semibold">문제 {num}</div>
                        <div className="text-xs">
                          {total ? total.score.toFixed(2) : "0.00"}/{total ? total.max.toFixed(2) : "0.00"}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="flex-1" style={{ fontSize: `${answerFontSize}px` }}>
                  {paragraphs.map((para, idx) => {
                    const sectionId = paragraphSectionMap[idx];
                    const active = idx === activeParagraphIndex;
                    let currentLevel = 1;
                    const lines = para.split(/\r?\n/).filter((line) => line.trim());
                    return (
                      <div
                        key={idx}
                        className={`mb-3 p-2 rounded ${active ? "bg-yellow-100" : "bg-white"}`}
                        onClick={() => {
                          setActiveParagraphIndex(idx);
                          if (sectionId) {
                            setActiveSectionId(sectionId);
                            const target = sectionRefs.current[sectionId];
                            if (target) {
                              target.scrollIntoView({ behavior: "smooth", block: "start" });
                            }
                          }
                        }}
                        onMouseEnter={() => {
                          setActiveParagraphIndex(idx);
                          if (sectionId) {
                            setActiveSectionId(sectionId);
                            const target = sectionRefs.current[sectionId];
                            if (target) {
                              target.scrollIntoView({ behavior: "smooth", block: "start" });
                            }
                          }
                        }}
                        onMouseLeave={() => {
                          setActiveParagraphIndex(null);
                          setActiveSectionId(null);
                        }}
                      >
                        {lines.map((line, lineIdx) => {
                          const level = detectHeadingLevel(line);
                          if (level !== null) {
                            currentLevel = level;
                          }
                          const indentLevel = level !== null ? Math.max(level - 1, 0) : currentLevel;
                          const isHeading = level === 1;
                          return (
                            <div
                              key={`${idx}-${lineIdx}`}
                              className={isHeading ? "font-semibold" : ""}
                              style={{ paddingLeft: 8 + indentLevel * 12 }}
                            >
                              {line}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div>
            {Object.entries(scoreTreeByProblem)
              .filter(([problemId]) => problemId === selectedProblemTab)
              .map(([problemId, group]) => (
              <div key={problemId} className="mb-6">
                <div className="mb-2 text-sm font-semibold text-gray-600">
                  문제 {problemId}
                  {problemTotals[problemId] && (
                    <span className="ml-2 text-xs text-gray-500">
                      {problemTotals[problemId].score.toFixed(2)}/{problemTotals[problemId].max.toFixed(2)}
                    </span>
                  )}
                </div>
                {group.roots.map((rootId) => {
                  const renderNode = (nodeId: string, depth: number) => {
                    const detail = group.nodes[nodeId];
                    if (!detail) return null;
                    const active = detail.section_id === activeSectionId;
                    const isLeaf = detail.is_leaf !== false;
                    const childSummary = childScoreMap[detail.section_id];
                    const hasDeductions = (detail.deductions || []).length > 0;
                    const hasNote = Boolean(detail.llm?.note);
                    return (
                      <div key={detail.section_id} className="mb-2">
                        <div
                          ref={(element) => {
                            if (!sectionRefs.current[detail.section_id]) {
                              sectionRefs.current[detail.section_id] = element;
                            }
                          }}
                          onMouseEnter={() => {
                            setActiveSectionId(detail.section_id);
                            const firstIndex = firstParagraphIndexBySection[detail.section_id];
                            if (firstIndex !== undefined) {
                              setActiveParagraphIndex(firstIndex);
                            }
                          }}
                          onMouseLeave={() => {
                            setActiveSectionId(null);
                            setActiveParagraphIndex(null);
                          }}
                          className={`border p-3 rounded ${active ? "border-blue-600 bg-blue-50" : "border-gray-200"} ${
                            isLeaf ? "" : "bg-gray-50 text-gray-700"
                          }`}
                          style={{ marginLeft: depth * 12 }}
                        >
                          <div className="font-semibold">
                            {detail.section_id} {detail.title}
                          </div>
                          {isLeaf ? (
                            <>
                              <div>
                                {detail.is_bonus ? (
                                  <span className="text-blue-600">가산: +{detail.score}</span>
                                ) : (
                                  <>점수: {detail.score} / {detail.max_points}</>
                                )}
                              </div>
                              {hasDeductions && (
                                <ul className="text-sm text-red-600">
                                  {(detail.deductions || []).map((d, deductionIdx) => (
                                    <li key={deductionIdx}>
                                      - {d.reason} ({d.penalty})
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {hasNote && (
                                <div className={`mt-1 text-xs ${hasDeductions ? "text-red-600" : "text-gray-700"}`}>
                                  {detail.llm?.note}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="text-sm text-gray-600">
                              하위 항목 합계: {childSummary ? childSummary.sum.toFixed(2) : 0} /{" "}
                              {childSummary ? childSummary.max.toFixed(2) : 0}
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
            {!scoreDetails.length && <div className="text-sm text-gray-500">채점 결과가 없습니다.</div>}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
