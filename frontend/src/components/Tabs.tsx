"use client";

type TabKey = "exam" | "grading" | "stats";

const tabs: { key: TabKey; label: string }[] = [
  { key: "exam", label: "시험 등록" },
  { key: "grading", label: "학생 채점" },
  { key: "stats", label: "시험별 수치" },
];

export default function Tabs({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (key: TabKey) => void;
}) {
  return (
    <div className="flex gap-2 mb-6">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`px-4 py-2 rounded ${
            active === tab.key ? "bg-blue-600 text-white" : "bg-gray-200"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
