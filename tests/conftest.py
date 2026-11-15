import os

# Keep tests independent of the deployment .env (load_dotenv never overrides
# variables that are already set).
os.environ["LLMREADER_URL_PREFIX"] = ""
os.environ.setdefault("LLMREADER_PASSWORD", "test-password")
os.environ.setdefault("LLMREADER_SECRET_KEY", "test-secret-key")
