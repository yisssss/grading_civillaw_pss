# Program2 - 채점 시스템

## 서버 실행 방법

### 1️⃣ 백엔드 서버 실행

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**환경변수 설정 (필수)**

`backend/.env` 파일을 생성하고 다음 내용을 추가하세요:

```env
DATABASE_URL=sqlite:///./app.db
GOOGLE_API_KEY=YOUR_GOOGLE_API_KEY
LLM_MODEL=gemini-2.0-flash-lite
```

**확인**: 브라우저에서 `http://localhost:8000/health` 접속 시 `{"status":"ok"}` 표시

---

### 2️⃣ 프론트엔드 서버 실행

```powershell
cd frontend
npm install
npm run dev
```

**환경변수 설정 (선택)**

`frontend/.env.local` 파일:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

**확인**: 브라우저에서 `http://localhost:3000` 접속

---

### 기존 DB 답안 줄바꿈 정규화

이미 저장된 답안 텍스트를 문단 정규화(헤딩 유지, 나머지 줄 합침)하려면:

```powershell
# PowerShell (curl은 Invoke-WebRequest 별칭이므로 -X 사용 불가)
Invoke-WebRequest -Method POST -Uri "http://localhost:8000/answers/normalize-all" -UseBasicParsing

# 실제 curl 사용 시
curl.exe -X POST http://localhost:8000/answers/normalize-all
```

응답 예: `{"total": 42, "updated": 38}`

---

## 주요 기능

- PDF 파일 파싱 (채점기준표, 모범답안, 학생답안)
- AI 기반 자동 채점 (Gemini API)
- 시험/학생/답안 관리
- 채점 결과 조회 및 통계
