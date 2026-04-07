import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from generate_training_data import generate_normal_entities
from feature_extractor import extract_features

# Step 1: Generate training data
print("Generating training data...")
normal_features = generate_normal_entities(1000)

# Step 2: Train the model
print("Training Isolation Forest...")
clf = IsolationForest(
    contamination=0.05, # expect ~5% anomalies
    n_estimators=100,
    random_state=42
)
clf.fit(normal_features)

# Step 3: Save the trained model
joblib.dump(clf, "models/anomaly_model.pkl")
print("Model saved to models/anomaly_model.pkl")