# Step 3 - Load JSON
import json, os
from sentence_transformers import SentenceTransformer
import faiss
import numpy as np

DATA_PATH = "data/lessons_seed.json"

def load_lessons():
    with open(DATA_PATH, "r") as f:
        lessons = json.load(f)
    print(f"Loaded {len(lessons)} lessons.")
    return lessons

# Step 4 - Embed
model = SentenceTransformer('all-MiniLM-L6-v2')

def embed_lessons(lessons):
    texts = []
    for lesson in lessons:
        wrong = lesson.get("what_was_wrong", "")
        ll = lesson.get("lessonsLearned", {})
        fix = ll.get("recommendation", "")
        texts.append(wrong + " " + fix)
    return model.encode(texts, show_progress_bar=True)

# Step 5 - Save FAISS index
def build_and_save_index(embeddings, lessons):
    index = faiss.IndexFlatL2(embeddings.shape[1])
    index.add(embeddings.astype(np.float32))
    os.makedirs("models", exist_ok=True)
    faiss.write_index(index, "models/lessons.index")
    with open("models/lessons.json", "w") as f:
        json.dump(lessons, f)
    print("Saved!")
    return index

# Step 6 - Search function
def search_lessons(query, index, lessons, top_k=3):
    query_vec = model.encode([query]).astype(np.float32)
    distances, indices = index.search(query_vec, top_k)
    for rank, idx in enumerate(indices[0]):
        l = lessons[idx]
        print(f"{rank+1}. {l['violationId']} - {l['parameterName']}")

# Run everything
lessons = load_lessons()
embeddings = embed_lessons(lessons)
index = build_and_save_index(embeddings, lessons)
search_lessons("Circle diameter exceeds upper limit", index, lessons)