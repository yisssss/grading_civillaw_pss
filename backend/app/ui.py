UI_HTML = """
<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Grading Admin (Minimal)</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; }
      h2 { margin-top: 24px; }
      button { margin: 4px 0; }
      pre { background: #f6f6f6; padding: 12px; border-radius: 6px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    </style>
  </head>
  <body>
    <h1>Grading Admin (Minimal)</h1>
    <p>현재는 목록 조회만 지원합니다. (UI 전 단계 점검용)</p>

    <div class="grid">
      <div>
        <h2>Exams</h2>
        <button onclick="loadExams()">Load</button>
        <pre id="exams"></pre>
      </div>
      <div>
        <h2>Students</h2>
        <button onclick="loadStudents()">Load</button>
        <pre id="students"></pre>
      </div>
    </div>

    <div class="grid">
      <div>
        <h2>Answers</h2>
        <button onclick="loadAnswers()">Load</button>
        <pre id="answers"></pre>
      </div>
      <div>
        <h2>Results</h2>
        <button onclick="loadResults()">Load</button>
        <pre id="results"></pre>
      </div>
    </div>

    <script>
      async function fetchJson(path) {
        const res = await fetch(path);
        return res.json();
      }
      async function loadExams() {
        const data = await fetchJson('/exams');
        document.getElementById('exams').textContent = JSON.stringify(data, null, 2);
      }
      async function loadStudents() {
        const data = await fetchJson('/students');
        document.getElementById('students').textContent = JSON.stringify(data, null, 2);
      }
      async function loadAnswers() {
        const data = await fetchJson('/answers');
        document.getElementById('answers').textContent = JSON.stringify(data, null, 2);
      }
      async function loadResults() {
        const data = await fetchJson('/results');
        document.getElementById('results').textContent = JSON.stringify(data, null, 2);
      }
    </script>
  </body>
</html>
"""
