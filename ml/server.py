from flask import Flask, request, jsonify
import joblib
from feature_extractor import extract_features

app = Flask(__name__)
clf = joblib.load("models/anomaly_model.pkl")

@app.route("/anomaly", methods=["POST"])
def detect_anomaly():
    entity = request.json # receive entity JSON
    features = extract_features(entity)
    score = clf.decision_function([features])[0]
    return jsonify({
       "anomaly": bool(score < -0.025),
        "score": round(float(score), 4)
    })

if __name__ == "__main__":
    app.run(port=8001)