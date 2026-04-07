# ml/generate_training_data.py — improved realistic training data

import random
from feature_extractor import extract_features

def generate_normal_entities(n=500):
    entities = []

    # Define realistic ranges per entity type and layer — based on Varroc schema
    templates = [
        # CIRCLE on DIMENSIONS — diameters typically 5mm to 100mm, tight tolerance
        {"entityType": "CIRCLE", "layer": "DIMENSIONS",
         "bbox": (10, 10, 110, 110), "tolerance": (0.02, 0.1),
         "nominal": (5, 100), "deviation_factor": 0.5},

        # TOLERANCE on GDT — small values, very tight
        {"entityType": "TOLERANCE", "layer": "GDT",
         "bbox": (0, 0, 20, 10), "tolerance": (0.02, 0.08),
         "nominal": (0, 0.05), "deviation_factor": 0.4},

        # DIMENSION on DIMENSIONS — lengths 10mm to 200mm
        {"entityType": "DIMENSION", "layer": "DIMENSIONS",
         "bbox": (0, 0, 200, 10), "tolerance": (0.05, 0.3),
         "nominal": (10, 200), "deviation_factor": 0.5},

        # LINE on DIMENSIONS — angles 0.5 to 5 deg or lengths
        {"entityType": "LINE", "layer": "DIMENSIONS",
         "bbox": (0, 0, 50, 20), "tolerance": (0.2, 0.8),
         "nominal": (0.5, 5.0), "deviation_factor": 0.4},

        # ARC on DIMENSIONS — radii 10mm to 50mm
        # Replace the ARC template with this — wider deviation factor
        {"entityType": "ARC", "layer": "DIMENSIONS",
        "bbox": (0, 0, 60, 60), "tolerance": (0.2, 0.8),
        "nominal": (10, 50), "deviation_factor": 0.7},  # was 0.4, now 0.7

        # MTEXT on TITLEBLOCK — no numeric values
        {"entityType": "MTEXT", "layer": "TITLEBLOCK",
         "bbox": (0, 0, 80, 10), "tolerance": (0, 0),
         "nominal": (0, 0), "deviation_factor": 0},
    ]

    for i in range(n):
        t = templates[i % len(templates)]

        # Build bounding box
        minX = random.uniform(t["bbox"][0], t["bbox"][0] + 10)
        minY = random.uniform(t["bbox"][1], t["bbox"][1] + 10)
        maxX = random.uniform(t["bbox"][2] - 10, t["bbox"][2])
        maxY = random.uniform(t["bbox"][3] - 10, t["bbox"][3])

        nominal    = random.uniform(t["nominal"][0], t["nominal"][1])
        tolerance  = random.uniform(t["tolerance"][0], t["tolerance"][1])

        # Normal entity — deviation is small fraction of tolerance
        deviation  = random.uniform(-tolerance * t["deviation_factor"],
                                     tolerance * t["deviation_factor"])
        measured   = nominal + deviation

        entity = {
            "entityType":    t["entityType"],
            "layer":         t["layer"],
            "boundingBox":   {"minX": minX, "minY": minY, "maxX": maxX, "maxY": maxY},
            "upperTolerance": tolerance,
            "textContent":   "",
            "nominalValue":  nominal,
            "measuredValue": measured
        }
        entities.append(extract_features(entity))

    return entities

if __name__ == "__main__":
    data = generate_normal_entities(500)
    print(f"Generated {len(data)} training samples")