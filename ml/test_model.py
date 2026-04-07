import joblib
from feature_extractor import extract_features

clf = joblib.load("models/anomaly_model.pkl")

# 10 normal entities — should all score > -0.2
normal = {"type":"LINE","layer":"DIM","bounding_box":{"width":50,"height":50},
          "tolerance_value_numeric":0.1,"text_length":"","distance_to_nearest_entity":10}

for i in range(10):
    score = clf.decision_function([extract_features(normal)])[0]
    print(f"Normal {i+1}: score={score:.3f} anomaly={score < -0.2}")

# 1 extreme entity — should score < -0.2 (flagged as anomaly)
extreme = {"type":"LINE","layer":"UNKNOWN","bounding_box":{"width":9999,"height":0.001},
           "tolerance_value_numeric":999,"text_length":"x"*500,"distance_to_nearest_entity":9999}

score = clf.decision_function([extract_features(extreme)])[0]
print(f"Extreme: score={score:.3f} anomaly={score > -0.2}")