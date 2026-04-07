from flask import Flask, request, jsonify, send_file
import joblib
from feature_extractor import extract_features
import faiss
import json
import os
import io
import numpy as np
from sentence_transformers import SentenceTransformer
from suggestion_engine import get_engine
from reports.pdf_generator import generate_pdf
from reports.excel_generator import generate_excel

SAMPLE_VIOLATIONS_PATH = os.path.join(os.path.dirname(__file__), 'data', 'sample_violations.json')

app = Flask(__name__)
clf = joblib.load("models/anomaly_model.pkl")

lessons_model = SentenceTransformer('all-MiniLM-L6-v2')
lessons_index = faiss.read_index("models/lessons.index")
with open("models/lessons.json") as f:
    lessons = json.load(f)

# Lazy-load suggestion engine (builds standards index on first use)
suggestion_engine = None
def get_suggestion_engine():
    global suggestion_engine
    if suggestion_engine is None:
        suggestion_engine = get_engine()
    return suggestion_engine


# ── /anomaly ─────────────────────────────────────────────────────────────────
@app.route("/anomaly", methods=["POST"])
def detect_anomaly():
    entity = request.json
    features = extract_features(entity)
    score = clf.decision_function([features])[0]
    return jsonify({
        "anomaly": bool(score < -0.025),
        "score": round(float(score), 4)
    })


# ── /lessons ─────────────────────────────────────────────────────────────────
@app.route("/lessons", methods=["POST"])
def get_lessons():
    body = request.get_json()
    query = body.get("violation_description", "")
    if not query:
        return jsonify({"error": "violation_description required"}), 400
    query_vec = lessons_model.encode([query]).astype(np.float32)
    distances, indices = lessons_index.search(query_vec, 3)
    results = []
    for rank, idx in enumerate(indices[0]):
        lesson = lessons[idx]
        ll = lesson.get("lessonsLearned", {})
        results.append({
            "rank": rank + 1,
            "violationId": lesson["violationId"],
            "what_was_wrong": lesson["what_was_wrong"],
            "how_it_was_fixed": ll.get("recommendation", ""),
            "riskScore": ll.get("riskScore", 0)
        })
    return jsonify({"top_lessons": results})


# ── /suggest  (Manual Mode — blocking, returns suggestion in response) ────────
@app.route("/suggest", methods=["POST"])
def suggest():
    """
    Manual Mode: generate LLM suggestion synchronously.
    Body: { violation_description, entity_type, layer, rule_id }
    Returns: { suggestion: "..." }
    """
    body = request.get_json()
    if not body or not body.get("violation_description"):
        return jsonify({"error": "violation_description required"}), 400

    violation = {
        "rule_id": body.get("rule_id", "UNKNOWN"),
        "entity_type": body.get("entity_type", "UNKNOWN"),
        "layer": body.get("layer", "UNKNOWN"),
        "violation_description": body.get("violation_description", ""),
    }

    engine = get_suggestion_engine()
    suggestion = engine.suggest_one(violation)
    return jsonify({"suggestion": suggestion})


# ── /suggest-batch  (Manual Mode — all violations at once) ───────────────────
@app.route("/suggest-batch", methods=["POST"])
def suggest_batch():
    """
    Manual Mode: generate suggestions for a list of violations before sending response.
    Body: { violations: [{ rule_id, entity_type, layer, violation_description }, ...] }
    Returns: { violations: [{ ...original, suggestion: "..." }, ...] }
    """
    body = request.get_json()
    violations = body.get("violations", [])
    if not violations:
        return jsonify({"error": "violations list required"}), 400

    engine = get_suggestion_engine()
    enriched = engine.suggest_all(violations)
    return jsonify({"violations": enriched})


# ── /suggest-realtime  (Real-Time Mode — returns immediately, pushes later) ──
@app.route("/suggest-realtime", methods=["POST"])
def suggest_realtime():
    """
    Real-Time Mode: spawns a background thread.
    Returns 202 immediately; suggestion is POSTed to Node.js /suggestion-ready
    after 1-2 seconds, then forwarded to AutoCAD plugin via ZeroMQ.
    Body: { violation_id, violation_description, entity_type, layer, rule_id }
    """
    body = request.get_json()
    violation_id = body.get("violation_id", "V-UNKNOWN")
    if not body or not body.get("violation_description"):
        return jsonify({"error": "violation_description required"}), 400

    violation = {
        "rule_id": body.get("rule_id", "UNKNOWN"),
        "entity_type": body.get("entity_type", "UNKNOWN"),
        "layer": body.get("layer", "UNKNOWN"),
        "violation_description": body.get("violation_description", ""),
    }

    engine = get_suggestion_engine()
    engine.suggest_realtime(violation, violation_id)

    return jsonify({
        "status": "processing",
        "message": f"Suggestion for {violation_id} will be pushed to /suggestion-ready shortly."
    }), 202


# ── /report/pdf — Generate PDF report ───────────────────────────────────────
# Body: /validate/full response schema (optional — falls back to sample data)
@app.route("/report/pdf", methods=["POST"])
def report_pdf():
    data = request.get_json(silent=True)
    if not data or not data.get('violations'):
        with open(SAMPLE_VIOLATIONS_PATH) as f:
            data = json.load(f)

    # Allow engineer name override
    if request.args.get('engineer'):
        data['engineer'] = request.args.get('engineer')

    try:
        pdf_bytes = generate_pdf(data)
        drawing_id = data.get('drawingId', 'report').replace('/', '-')
        filename = f"{drawing_id}_validation_report.pdf"
        return send_file(
            io.BytesIO(pdf_bytes),
            mimetype='application/pdf',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── /report/excel — Generate Excel report ─────────────────────────────────────
# Body: /validate/full response schema (optional — falls back to sample data)
@app.route("/report/excel", methods=["POST"])
def report_excel():
    data = request.get_json(silent=True)
    if not data or not data.get('violations'):
        with open(SAMPLE_VIOLATIONS_PATH) as f:
            data = json.load(f)

    if request.args.get('engineer'):
        data['engineer'] = request.args.get('engineer')

    try:
        excel_bytes = generate_excel(data)
        drawing_id = data.get('drawingId', 'report').replace('/', '-')
        filename = f"{drawing_id}_validation_report.xlsx"
        return send_file(
            io.BytesIO(excel_bytes),
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(port=8001)