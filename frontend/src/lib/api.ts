import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
});

export const examsApi = {
  list: () => api.get("/exams").then((r) => r.data),
  create: (form: FormData) => api.post("/exams", form).then((r) => r.data),
  createEmpty: (payload: { name: string }) =>
    api.post("/exams/simple", payload).then((r) => r.data),
  update: (examId: number, payload: { name: string }) =>
    api.put(`/exams/${examId}`, payload).then((r) => r.data),
  delete: (examId: number) => api.delete(`/exams/${examId}`).then((r) => r.data),
  getRubricJson: (examId: number) =>
    api.get(`/exams/${examId}/rubric_json`).then((r) => r.data),
};

export const studentsApi = {
  list: () => api.get("/students").then((r) => r.data),
  create: (payload: { student_id: string; name: string }) =>
    api.post("/students", payload).then((r) => r.data),
  update: (studentId: number, payload: { student_id: string; name: string }) =>
    api.put(`/students/${studentId}`, payload).then((r) => r.data),
  delete: (studentId: number) => api.delete(`/students/${studentId}`).then((r) => r.data),
};

export const answersApi = {
  list: (examId?: number, studentId?: number) => {
    const params: Record<string, number> = {};
    if (examId) params.exam_id = examId;
    if (studentId) params.student_id = studentId;
    return api.get("/answers", { params }).then((r) => r.data);
  },
  upload: (form: FormData) => api.post("/answers", form).then((r) => r.data),
  uploadText: (form: FormData) => api.post("/answers/text", form).then((r) => r.data),
  get: (answerId: number) => api.get(`/answers/${answerId}`).then((r) => r.data),
  delete: (answerId: number) => api.delete(`/answers/${answerId}`).then((r) => r.data),
};

export const gradeApi = {
  run: (answerId: number, useLlm = true) =>
    api.post(`/grade/run?answer_id=${answerId}&use_llm=${useLlm}`).then((r) => r.data),
  getResult: (answerId: number) =>
    api.get(`/results/${answerId}`).then((r) => r.data),
  updateResult: (answerId: number, resultJson: object) =>
    api.put(`/results/${answerId}`, { result_json: resultJson }).then((r) => r.data),
  exportPdf: (payload: { answer_ids: number[]; mode: "single" | "batch" }) =>
    api.post("/results/export/pdf", payload, { responseType: "blob" }),
  listResults: (examId?: number, studentId?: number) => {
    const params: Record<string, number> = {};
    if (examId) params.exam_id = examId;
    if (studentId) params.student_id = studentId;
    return api.get("/results", { params }).then((r) => r.data);
  },
};

export type RubricContextPayload = {
  fact_pattern: string;
  question: string;
};

export type RubricSubSectionPayload = {
  label: string;
  title: string;
  points: number | null;
  content: string;
  sub_sections?: RubricSubSectionPayload[] | null;
};

export type RubricSectionPayload = RubricSubSectionPayload;

export type RubricProblemPayload = {
  id: string;
  total_points: number | null;
  sections: RubricSectionPayload[];
};

export type RubricCreatePayload = {
  exam_id: number;
  context: RubricContextPayload[];
  problems: RubricProblemPayload[];
};

export const rubricApi = {
  create: (payload: RubricCreatePayload) =>
    api.post("/rubric/create", payload).then((r) => r.data),
};
