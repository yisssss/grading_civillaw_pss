import os

from dotenv import load_dotenv


load_dotenv()


def get_settings() -> dict:
    return {
        "DATABASE_URL": os.getenv("DATABASE_URL", "sqlite:///./app.db"),
        "GOOGLE_API_KEY": os.getenv("GOOGLE_API_KEY", ""),
        "LLM_MODEL": os.getenv("LLM_MODEL", "gemini-2.0-flash-exp"),
        "LLM_MAX_CHARS": os.getenv("LLM_MAX_CHARS", "6000"),
        "LLM_RETRIES": os.getenv("LLM_RETRIES", "2"),
        "LLM_BACKOFF": os.getenv("LLM_BACKOFF", "1.5"),
    }
