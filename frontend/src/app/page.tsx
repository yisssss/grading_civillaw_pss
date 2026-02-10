"use client";

import { useState } from "react";
import Tabs from "@/components/Tabs";
import ExamUpload from "@/components/ExamUpload";
import StudentGrading from "@/components/StudentGrading";
import StatsView from "@/components/StatsView";
import StudentsManage from "@/components/StudentsManage";
import GradingReview from "@/components/GradingReview";

type TabKey = "exam" | "grading" | "review" | "students" | "stats";

export default function Page() {
  const [active, setActive] = useState<TabKey>("exam");

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">민법 사례형 채점 보조</h1>
      <Tabs active={active} onChange={setActive} />
      {active === "exam" && <ExamUpload />}
      {active === "students" && <StudentsManage />}
      {active === "grading" && <StudentGrading />}
      {active === "review" && <GradingReview />}
      {active === "stats" && <StatsView />}
    </div>
  );
}
