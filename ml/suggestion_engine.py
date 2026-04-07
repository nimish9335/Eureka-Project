"""
ml/suggestion_engine.py — RAG-based LLM Suggestion Engine
Uses:
  - Standards KB (YAML → FAISS) for relevant rule retrieval
  - Lessons Learned FAISS index for similar past fixes
  - Claude claude-sonnet-4-20250514 to generate a one-sentence actionable fix
  - In-memory dict cache keyed by (rule_id, entity_type)
  - Manual mode: blocking / Real-Time mode: background thread
"""

import json
import os
import threading
import time

import anthropic
import faiss
import numpy as np
import requests
import yaml
from sentence_transformers import SentenceTransformer

# ─── Paths ────────────────────────────────────────────────────────────────────
_DIR = os.path.dirname(os.path.abspath(__file__))
STANDARDS_YAML = os.path.join(_DIR, "data", "standards_kb.yaml")
LESSONS_INDEX_PATH = os.path.join(_DIR, "models", "lessons.index")
LESSONS_JSON_PATH = os.path.join(_DIR, "models", "lessons.json")
STANDARDS_INDEX_PATH = os.path.join(_DIR, "models", "standards.index")
STANDARDS_JSON_PATH = os.path.join(_DIR, "models", "standards_chunks.json")

# ─── Suggestion Engine ────────────────────────────────────────────────────────
class SuggestionEngine:
    def __init__(self, node_url: str = "http://127.0.0.1:8000"):
        self.node_url = node_url                  # Node.js backend URL for real-time push
        self._cache: dict[str, str] = {}          # key: "{rule_id}::{entity_type}"
        self._model = SentenceTransformer("all-MiniLM-L6-v2")
        self._client = anthropic.Anthropic()      # reads ANTHROPIC_API_KEY from env

        # Load lessons FAISS index + lessons list
        self._lessons_index = faiss.read_index(LESSONS_INDEX_PATH)
        with open(LESSONS_JSON_PATH) as f:
            self._lessons: list[dict] = json.load(f)

        # Build (or load) standards FAISS index
        self._standards_index, self._standards_chunks = self._load_or_build_standards_index()

        print("[SuggestionEngine] Ready.")

    # ── Standards Index ───────────────────────────────────────────────────────
    def _load_or_build_standards_index(self):
        """Load pre-built standards index or build it from YAML and persist."""
        if os.path.exists(STANDARDS_INDEX_PATH) and os.path.exists(STANDARDS_JSON_PATH):
            idx = faiss.read_index(STANDARDS_INDEX_PATH)
            with open(STANDARDS_JSON_PATH) as f:
                chunks = json.load(f)
            print(f"[SuggestionEngine] Loaded standards index ({len(chunks)} rules).")
            return idx, chunks

        print("[SuggestionEngine] Building standards FAISS index from YAML…")
        with open(STANDARDS_YAML) as f:
            data = yaml.safe_load(f)

        standards = data.get("standards", [])
        chunks = []
        texts = []
        for rule in standards:
            chunks.append({
                "rule_id": rule["rule_id"],
                "standard": rule["standard"],
                "category": rule["category"],
                "entity_types": rule["entity_types"],
                "layer": rule["layer"],
                "chunk": rule["chunk"],
            })
            texts.append(rule["chunk"])

        embeddings = self._model.encode(texts, show_progress_bar=True).astype(np.float32)
        idx = faiss.IndexFlatL2(embeddings.shape[1])
        idx.add(embeddings)

        os.makedirs(os.path.dirname(STANDARDS_INDEX_PATH), exist_ok=True)
        faiss.write_index(idx, STANDARDS_INDEX_PATH)
        with open(STANDARDS_JSON_PATH, "w") as f:
            json.dump(chunks, f, indent=2)

        print(f"[SuggestionEngine] Built standards index ({len(chunks)} rules).")
        return idx, chunks

    # ── Retrieval ─────────────────────────────────────────────────────────────
    def _retrieve_standard_chunks(self, query: str, top_k: int = 2) -> list[str]:
        vec = self._model.encode([query]).astype(np.float32)
        _, idxs = self._standards_index.search(vec, top_k)
        return [self._standards_chunks[i]["chunk"] for i in idxs[0] if i < len(self._standards_chunks)]

    def _retrieve_lesson(self, query: str) -> str:
        vec = self._model.encode([query]).astype(np.float32)
        _, idxs = self._lessons_index.search(vec, 1)
        idx = idxs[0][0]
        if idx >= len(self._lessons):
            return "No similar past lesson found."
        lesson = self._lessons[idx]
        ll = lesson.get("lessonsLearned", {})
        return (
            f"{lesson.get('what_was_wrong', '')} — "
            f"Fix: {ll.get('recommendation', 'N/A')} "
            f"(Risk score: {ll.get('riskScore', 0):.2f})"
        )

    # ── Cache ─────────────────────────────────────────────────────────────────
    def _cache_key(self, rule_id: str, entity_type: str) -> str:
        return f"{rule_id}::{entity_type}"

    def _get_cached(self, rule_id: str, entity_type: str) -> str | None:
        return self._cache.get(self._cache_key(rule_id, entity_type))

    def _set_cached(self, rule_id: str, entity_type: str, suggestion: str):
        self._cache[self._cache_key(rule_id, entity_type)] = suggestion

    # ── Core: generate one suggestion ────────────────────────────────────────
    def _generate_suggestion(self, violation: dict) -> str:
        """
        violation dict keys expected:
          entity_type, layer, violation_description, rule_id (optional)
        Returns a single plain-English sentence.
        """
        entity_type = violation.get("entity_type", "UNKNOWN")
        layer = violation.get("layer", "UNKNOWN")
        description = violation.get("violation_description", "")
        rule_id = violation.get("rule_id", "UNKNOWN")

        # Cache hit
        cached = self._get_cached(rule_id, entity_type)
        if cached:
            print(f"[SuggestionEngine] Cache hit for {rule_id}::{entity_type}")
            return cached

        # RAG retrieval
        query = f"{entity_type} {layer} {description}"
        standard_chunks = self._retrieve_standard_chunks(query, top_k=2)
        standard_text = "\n".join(standard_chunks)
        lesson_text = self._retrieve_lesson(query)

        # Build prompt
        prompt = (
            f"You are a CAD validation assistant for Varroc Engineering.\n"
            f"Entity: {entity_type} on layer {layer}.\n"
            f"Violation: {description}\n"
            f"Relevant standard:\n{standard_text}\n"
            f"Similar past fix: {lesson_text}\n"
            f"In exactly one sentence, tell the engineer the specific action to fix this."
        )

        # Claude API call
        try:
            response = self._client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=150,
                messages=[{"role": "user", "content": prompt}],
            )
            suggestion = response.content[0].text.strip()
        except Exception as e:
            print(f"[SuggestionEngine] Claude API error: {e}")
            suggestion = f"Fix: ensure {entity_type} on layer {layer} complies with {rule_id}."

        # Cache and return
        self._set_cached(rule_id, entity_type, suggestion)
        return suggestion

    # ── Manual Mode ───────────────────────────────────────────────────────────
    def suggest_all(self, violations: list[dict]) -> list[dict]:
        """
        Manual mode: process ALL violations synchronously before sending response.
        Returns violations with 'suggestion' field added.
        """
        results = []
        for v in violations:
            suggestion = self._generate_suggestion(v)
            results.append({**v, "suggestion": suggestion})
        return results

    def suggest_one(self, violation: dict) -> str:
        """Single synchronous suggestion."""
        return self._generate_suggestion(violation)

    # ── Real-Time Mode ────────────────────────────────────────────────────────
    def suggest_realtime(self, violation: dict, violation_id: str):
        """
        Real-time mode: spawn a background thread.
        After generating the suggestion, POST it to Node.js /suggestion-ready.
        Node.js then forwards it to the AutoCAD plugin via ZeroMQ.
        """
        thread = threading.Thread(
            target=self._realtime_worker,
            args=(violation, violation_id),
            daemon=True,
        )
        thread.start()

    def _realtime_worker(self, violation: dict, violation_id: str):
        time.sleep(0.1)  # Small delay to let the main response return first
        suggestion = self._generate_suggestion(violation)
        payload = {
            "violationId": violation_id,
            "suggestion": suggestion,
            "entity_type": violation.get("entity_type"),
            "layer": violation.get("layer"),
        }
        try:
            resp = requests.post(f"{self.node_url}/suggestion-ready", json=payload, timeout=5)
            print(f"[SuggestionEngine] Pushed suggestion for {violation_id}: {resp.status_code}")
        except Exception as e:
            print(f"[SuggestionEngine] Failed to push suggestion to Node.js: {e}")


# ─── Module-level singleton (lazy init) ──────────────────────────────────────
_engine_instance: SuggestionEngine | None = None

def get_engine() -> SuggestionEngine:
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = SuggestionEngine()
    return _engine_instance


# ─── Quick self-test ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    engine = get_engine()
    test_violation = {
        "rule_id": "V-DWG-001",
        "entity_type": "DIMENSION",
        "layer": "OBJECT",
        "violation_description": "Dimension entity found on OBJECT layer instead of DIMENSIONS layer.",
    }
    print("\n=== Manual Mode Test ===")
    result = engine.suggest_one(test_violation)
    print(f"Suggestion: {result}")

    print("\n=== Cache Test (same call, should be instant) ===")
    result2 = engine.suggest_one(test_violation)
    print(f"Suggestion (cached): {result2}")
