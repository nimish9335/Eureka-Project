# ml/feature_extractor.py  — updated for Varroc schema

def extract_features(entity):
    # Entity type as number
    type_map = {"LINE": 1, "ARC": 2, "CIRCLE": 3,
                "DIMENSION": 4, "TOLERANCE": 5, "MTEXT": 6, "INSERT": 7}
    entity_type = type_map.get(entity.get("entityType", ""), 0)

    # Layer name hashed to a number
    layer_hash = hash(entity.get("layer", "")) % 1000

    # Bounding box area — your schema uses boundingBox with minX/maxX/minY/maxY
    bb = entity.get("boundingBox", {})
    width  = bb.get("maxX", 0) - bb.get("minX", 0)
    height = bb.get("maxY", 0) - bb.get("minY", 0)
    area   = width * height
    aspect = width / max(height, 0.001)

    # Tolerance — your schema has upperTolerance as a direct field
    tolerance = entity.get("upperTolerance", 0) or 0

    # Text content length
    text_len = len(entity.get("textContent", "") or "")

    # Measured vs nominal deviation (NEW — your schema has both!)
    measured  = entity.get("measuredValue", 0) or 0
    nominal   = entity.get("nominalValue", 0) or 0
    deviation = abs(measured - nominal)

    return [entity_type, layer_hash, area, aspect, tolerance, text_len, deviation]