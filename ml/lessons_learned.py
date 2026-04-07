import json, os, argparse, numpy as np, faiss
from sentence_transformers import SentenceTransformer

LESSONS_SEED_PATH = "ml/data/lessons_seed.json"
INDEX_SAVE_PATH   = "models/lessons.index"
LESSONS_SAVE_PATH = "models/lessons_list.json"
MODEL_NAME        = "all-MiniLM-L6-v2"

model, index, lessons = None, None, None

def load_index():
    global model, index, lessons
    model   = SentenceTransformer(MODEL_NAME)
    index   = faiss.read_index(INDEX_SAVE_PATH)
    lessons = json.load(open(LESSONS_SAVE_PATH))
    print(f"Ready — {index.ntotal} lessons indexed")

def find_similar_lessons(violation_description, top_k=3):
    if index is None: load_index()
    q = np.array(model.encode([violation_description])).astype("float32")
    distances, indices = index.search(q, top_k)
    results = []
    for rank, (dist, pos) in enumerate(zip(distances[0], indices[0])):
        if pos == -1: continue
        l = lessons[pos]
        ll = l.get("lessonsLearned", {})
        results.append({
            "violationId":      l.get("violationId"),
            "what_was_wrong":   l.get("what_was_wrong"),
            "recommendation":   ll.get("recommendation"),
            "rootCausePattern": ll.get("rootCausePattern"),
            "riskScore":        ll.get("riskScore"),
            "previousFailures": ll.get("previousFailures"),
            "dateFixed":        l.get("dateFixed"),
            "similarity_rank":  rank + 1,
            "l2_distance":      round(float(dist), 4),
        })
    return results

def build_and_save():
    global model, index, lessons
    lessons = json.load(open(LESSONS_SEED_PATH))
    print(f"Loaded {len(lessons)} lessons")
    texts = [l.get("what_was_wrong","") + " " + l.get("lessonsLearned",{}).get("recommendation","") for l in lessons]
    model = SentenceTransformer(MODEL_NAME)
    embeddings = np.array(model.encode(texts, show_progress_bar=True)).astype("float32")
    print(f"Embeddings shape: {embeddings.shape}")
    index = faiss.IndexFlatL2(embeddings.shape[1])
    index.add(embeddings)
    os.makedirs("models", exist_ok=True)
    faiss.write_index(index, INDEX_SAVE_PATH)
    json.dump(lessons, open(LESSONS_SAVE_PATH, "w"), indent=2)
    print("Index saved. Running self-test...")
    r = find_similar_lessons("Lens bore diameter oversize causing misalignment")
    for x in r:
        print(f"  #{x['similarity_rank']} {x['violationId']} risk={x['riskScore']}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()
    if args.build:
        build_and_save()
    else:
        print("Usage: python lessons_learned.py --build")
